import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { win32 } from "node:path";

const CLEANUP_FAILURE_EXIT_CODE = 125;
const CONTROL_TIMEOUT_MS = 10_000;

interface WindowsJobProcessOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

/** The controller owns the only job handle; its death also terminates the job. */
export function spawnWindowsJobProcess(options: WindowsJobProcessOptions): {
  child: ChildProcessWithoutNullStreams;
  terminate: () => Promise<void>;
} {
  const systemRoot = options.env.SYSTEMROOT ?? options.env.SystemRoot ?? process.env.SystemRoot ?? process.env.SYSTEMROOT;
  if (!systemRoot || !win32.isAbsolute(systemRoot)) throw new Error("Windows system directory is unavailable.");
  const powershell = win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const eventName = `Local\\ArdorLocalAgentStop-${randomUUID()}`;
  const commandLine = [options.command, ...options.args].map(quoteWindowsArgument).join(" ");
  const launchScript = `
$ErrorActionPreference = 'Stop'
$event = [Threading.EventWaitHandle]::new($false, [Threading.EventResetMode]::ManualReset, '${eventName}')
try {
  Add-Type -TypeDefinition @'
${WINDOWS_JOB_CONTROLLER}
'@
  $code = [ArdorLocalAgentJob]::Run(${powershellString(options.command)}, ${powershellString(commandLine)}, ${powershellString(options.cwd)}, $event.SafeWaitHandle.DangerousGetHandle(), ${process.pid})
  [Environment]::Exit($code)
} catch {
  [Console]::Error.WriteLine('Local Cerebrum Windows controller could not start.')
  [Environment]::Exit(126)
} finally { $event.Dispose() }
`;
  const child = spawn(powershell, powershellArguments(launchScript), {
    cwd: options.cwd, env: options.env, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
  });
  const exited = new Promise<void>((resolveExit) => {
    child.once("exit", () => resolveExit());
    child.once("error", () => resolveExit());
  });
  return {
    child,
    terminate: async () => {
      if (child.pid === undefined) return;
      if (child.exitCode === null && child.signalCode === null) {
        const signalScript = `
$ErrorActionPreference = 'Stop'
$deadline = [DateTime]::UtcNow.AddSeconds(5)
while ($true) {
  try { $event = [Threading.EventWaitHandle]::OpenExisting('${eventName}'); break }
  catch [Threading.WaitHandleCannotBeOpenedException] {
    if ([DateTime]::UtcNow -ge $deadline) { [Environment]::Exit(1) }
    Start-Sleep -Milliseconds 25
  }
}
try { $null = $event.Set() } finally { $event.Dispose() }
`;
        const signal = spawn(powershell, powershellArguments(signalScript), {
          env: options.env, windowsHide: true, shell: false, stdio: "ignore",
        });
        // Race completion of the controller, not the numeric PID. If it exits
        // before OpenExisting, the missing event is an expected race.
        const signalled = new Promise<void>((resolveSignal, reject) => {
          signal.once("error", reject);
          signal.once("exit", (code) => code === 0 ? resolveSignal() : reject(new Error("Windows runtime stop signal failed.")));
        });
        try {
          await withinTimeout(Promise.race([exited, signalled.then(() => exited)]));
        } finally {
          if (signal.exitCode === null && signal.signalCode === null) signal.kill();
        }
      }
      if (child.exitCode === CLEANUP_FAILURE_EXIT_CODE || child.signalCode !== null) {
        throw new Error("Local Cerebrum Windows job termination could not be verified.");
      }
    },
  };
}

function powershellArguments(script: string): string[] {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  // Leave space for the executable path, switches and native quoting.
  if (encoded.length > 30_000) throw new RangeError("Windows runtime launch command is too large.");
  return ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded];
}

function powershellString(value: string): string {
  return `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(value).toString("base64")}'))`;
}

function quoteWindowsArgument(value: string): string {
  if (value.includes("\0")) throw new TypeError("Windows process argument contains a null byte.");
  let quoted = '"';
  let slashes = 0;
  for (const character of value) {
    if (character === "\\") { slashes += 1; continue; }
    quoted += "\\".repeat(character === '"' ? slashes * 2 + 1 : slashes) + character;
    slashes = 0;
  }
  return `${quoted}${"\\".repeat(slashes * 2)}"`;
}

async function withinTimeout(promise: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Local Cerebrum Windows job termination timed out.")), CONTROL_TIMEOUT_MS);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

// SECURITY(ARD-2909): attach at creation through JOB_LIST, before any user code
// can run. No breakaway flag is allowed. Only the three stdio handles are inherited.
// https://devblogs.microsoft.com/oldnewthing/20230209-00/?p=107812
const WINDOWS_JOB_CONTROLLER = String.raw`
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class ArdorLocalAgentJob {
  [StructLayout(LayoutKind.Sequential)] struct Limits {
    public long ProcessTime, JobTime;
    public uint Flags;
    public UIntPtr MinWorkingSet, MaxWorkingSet;
    public uint ActiveLimit;
    public UIntPtr Affinity;
    public uint Priority, Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct Io {
    public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
  }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
    public Limits Basic;
    public Io Counters;
    public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
  }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct Startup {
    public uint Size;
    public string Reserved, Desktop, Title;
    public uint X, Y, XSize, YSize, XChars, YChars, Fill, Flags;
    public ushort Show, ReservedBytes;
    public IntPtr ReservedPointer, Input, Output, Error;
  }
  [StructLayout(LayoutKind.Sequential)] struct StartupEx {
    public Startup Base;
    public IntPtr Attributes;
  }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo {
    public IntPtr Process, Thread;
    public uint ProcessId, ThreadId;
  }
  [StructLayout(LayoutKind.Sequential)] struct Accounting {
    public long UserTime, KernelTime, PeriodUserTime, PeriodKernelTime;
    public uint PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses;
  }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
  static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits limits, uint size);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool QueryInformationJobObject(IntPtr job, int kind, out Accounting info, uint size, IntPtr length);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr key, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
  static extern bool CreateProcessW(string app, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes,
    bool inherit, uint flags, IntPtr env, string cwd, ref StartupEx startup, out ProcessInfo info);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int kind);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern uint WaitForMultipleObjects(uint count, IntPtr[] handles, bool all, uint timeout);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

  static void Check(bool success) { if (!success) throw new Win32Exception(Marshal.GetLastWin32Error()); }

  static void DrainJob(IntPtr job) {
    Check(TerminateJobObject(job, 1));
    var deadline = Stopwatch.StartNew();
    while (true) {
      Accounting info;
      Check(QueryInformationJobObject(job, 1, out info, (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero));
      if (info.ActiveProcesses == 0) return;
      if (deadline.ElapsedMilliseconds >= 5000) throw new TimeoutException();
      Thread.Sleep(10);
    }
  }

  public static int Run(string app, string command, string cwd, IntPtr stopEvent, uint desktopPid) {
    IntPtr job = IntPtr.Zero, attributes = IntPtr.Zero, jobList = IntPtr.Zero, handles = IntPtr.Zero;
    IntPtr desktop = IntPtr.Zero;
    ProcessInfo child = new ProcessInfo();
    bool attributesReady = false;
    int result = 126;
    try {
      // Hold the Desktop process handle so controller/runtime lifetime cannot
      // outlive Desktop, and a later reused numeric PID cannot extend it.
      desktop = OpenProcess(0x100000, false, desktopPid); // SYNCHRONIZE
      Check(desktop != IntPtr.Zero);
      job = CreateJobObjectW(IntPtr.Zero, null);
      Check(job != IntPtr.Zero);
      var limits = new ExtendedLimits();
      limits.Basic.Flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
      Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits))));
      IntPtr bytes = IntPtr.Zero;
      InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref bytes);
      if (bytes == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
      attributes = Marshal.AllocHGlobal(bytes);
      Check(InitializeProcThreadAttributeList(attributes, 2, 0, ref bytes));
      attributesReady = true;
      jobList = Marshal.AllocHGlobal(IntPtr.Size);
      Marshal.WriteIntPtr(jobList, job);
      Check(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x2000D), jobList, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero));
      handles = Marshal.AllocHGlobal(IntPtr.Size * 3);
      var startup = new StartupEx();
      startup.Base.Size = (uint)Marshal.SizeOf(typeof(StartupEx));
      startup.Base.Flags = 0x100; // STARTF_USESTDHANDLES
      startup.Base.Input = GetStdHandle(-10);
      startup.Base.Output = GetStdHandle(-11);
      startup.Base.Error = GetStdHandle(-12);
      var stdio = new IntPtr[] { startup.Base.Input, startup.Base.Output, startup.Base.Error };
      for (int index = 0; index < stdio.Length; index++) {
        Check(SetHandleInformation(stdio[index], 1, 1));
        Marshal.WriteIntPtr(handles, index * IntPtr.Size, stdio[index]);
      }
      Check(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x20002), handles, new IntPtr(IntPtr.Size * 3), IntPtr.Zero, IntPtr.Zero));
      startup.Attributes = attributes;
      // EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW; assignment is atomic.
      Check(CreateProcessW(app, new StringBuilder(command), IntPtr.Zero, IntPtr.Zero, true, 0x08080000, IntPtr.Zero, cwd, ref startup, out child));
      uint wait = WaitForMultipleObjects(3, new IntPtr[] { child.Process, stopEvent, desktop }, false, 0xFFFFFFFF);
      if (wait > 2) throw new Win32Exception(Marshal.GetLastWin32Error());
      uint exitCode = 0;
      if (wait == 0) Check(GetExitCodeProcess(child.Process, out exitCode));
      // Exit 125 is reserved for unverified cleanup, even if the runtime uses it.
      result = exitCode == 125 ? 126 : unchecked((int)exitCode);
    } catch {
      Console.Error.WriteLine("Local Cerebrum Windows job controller failed.");
      result = 126;
    } finally {
      if (job != IntPtr.Zero) {
        try { DrainJob(job); }
        catch { result = 125; }
      }
      if (child.Thread != IntPtr.Zero) CloseHandle(child.Thread);
      if (child.Process != IntPtr.Zero) CloseHandle(child.Process);
      if (desktop != IntPtr.Zero) CloseHandle(desktop);
      if (attributesReady) DeleteProcThreadAttributeList(attributes);
      if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
      if (jobList != IntPtr.Zero) Marshal.FreeHGlobal(jobList);
      if (handles != IntPtr.Zero) Marshal.FreeHGlobal(handles);
      if (job != IntPtr.Zero) CloseHandle(job);
    }
    return result;
  }
}
`;
