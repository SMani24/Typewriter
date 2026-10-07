#!/usr/bin/env python3
"""Install a per-user Linux application-menu entry; no sudo needed."""
import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MARKER = "# Installed by Typewriter"


def quote_exec(value):
    # Desktop Exec arguments aren't shell commands. Escape for both the desktop
    # string parser and the quoted Exec argument parser, including field codes.
    value = str(value).replace("%", "%%")
    for char in ["\\", '"', "$", "`"]:
        value = value.replace(char, "\\" + char)
    return '"' + value.replace("\\", "\\\\") + '"'


def desktop_value(value):
    return str(value).replace("\\", "\\\\").replace("\n", "\\n")


def entry():
    command = quote_exec(Path(sys.executable).resolve()) + " " + quote_exec(ROOT / "desktop" / "launch.py")
    return f"""{MARKER}
[Desktop Entry]
Type=Application
Name=Typewriter
GenericName=Spelling Practice
Comment=Practise your spelling, one word at a time
Exec={command}
Path={desktop_value(ROOT)}
Icon={desktop_value(ROOT / 'static' / 'favicon.svg')}
Terminal=false
StartupNotify=false
Categories=Education;Languages;
Keywords=IELTS;spelling;words;practice;writing;
Actions=Stop;

[Desktop Action Stop]
Name=Stop Typewriter
Exec={command} --stop
"""


def main():
    parser = argparse.ArgumentParser(description="Add Typewriter to your application menu")
    parser.add_argument("--applications-dir", type=Path, help="Override the per-user applications directory")
    args = parser.parse_args()
    directory = args.applications_dir or Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local/share")) / "applications"
    target = directory / "typewriter.desktop"
    if target.exists() and not target.read_text().startswith(MARKER):
        parser.error(f"{target} already belongs to another application. It has not been changed.")
    directory.mkdir(parents=True, exist_ok=True)
    target.write_text(entry())
    target.chmod(0o755)
    if shutil.which("desktop-file-validate"):
        subprocess.run(["desktop-file-validate", str(target)], check=True)
    if shutil.which("update-desktop-database"):
        subprocess.run(["update-desktop-database", str(directory)], check=False, capture_output=True)
    print(f"Installed {target}\nSearch for Typewriter in your application launcher.")


if __name__ == "__main__":
    main()
