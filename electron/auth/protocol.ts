export interface ShellProtocolRegistration {
  protocol: string;
  executablePath: string | undefined;
  args: string[] | undefined;
}
export function getShellProtocolRegistration(
  protocol: string,
  defaultApp: boolean,
  executablePath: string,
  entrypoint: string | undefined,
): ShellProtocolRegistration {
  if (defaultApp && entrypoint) {
    return { protocol, executablePath, args: [entrypoint] };
  }
  return { protocol, executablePath: undefined, args: undefined };
}
