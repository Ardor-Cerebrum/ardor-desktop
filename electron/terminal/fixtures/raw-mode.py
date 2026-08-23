import os
import sys
import termios
import tty

fd = sys.stdin.fileno()
print(f"__TTY__{int(os.isatty(fd))}", flush=True)
previous = termios.tcgetattr(fd)
try:
    tty.setraw(fd)
    sys.stdout.write("__RAW_READY__")
    sys.stdout.flush()
    data = os.read(fd, 3)
finally:
    termios.tcsetattr(fd, termios.TCSADRAIN, previous)

sys.stdout.write("\r\n__RAW__" + data.hex() + "\r\n")
sys.stdout.flush()
