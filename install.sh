#!/bin/sh

set -u

PROGRAM=${0##*/}
TEMP_DIR=
UUID=

info() {
    printf '%s: %s\n' "$PROGRAM" "$*"
}

warn() {
    printf '%s: warning: %s\n' "$PROGRAM" "$*" >&2
}

fail() {
    printf '%s: error: %s\n' "$PROGRAM" "$*" >&2
    exit 1
}

cleanup() {
    if [ -n "$TEMP_DIR" ] && [ -d "$TEMP_DIR" ]; then
        rm -rf "$TEMP_DIR" || warn "could not remove temporary directory: $TEMP_DIR"
    fi
}

handle_signal() {
    signal_name=$1
    trap - HUP INT TERM
    cleanup
    fail "interrupted by $signal_name"
}

trap cleanup 0
trap 'handle_signal HUP' HUP
trap 'handle_signal INT' INT
trap 'handle_signal TERM' TERM

SCRIPT_DIR=$(CDPATH= cd "$(dirname "$0")" 2>/dev/null && pwd) ||
    fail "could not locate the script directory"
METADATA_FILE=$SCRIPT_DIR/metadata.json
EXTENSION_FILE=$SCRIPT_DIR/extension.js

if [ ! -r "$METADATA_FILE" ] || [ ! -r "$EXTENSION_FILE" ]; then
    fail "metadata.json or extension.js is missing; run this script from a complete checkout"
fi

for required_command in gnome-shell gnome-extensions gjs python3 mktemp sed; do
    if ! command -v "$required_command" >/dev/null 2>&1; then
        case $required_command in
            python3)
                fail "python3 is required to validate metadata.json; install Python 3 and retry"
                ;;
            gnome-extensions)
                fail "gnome-extensions is missing; install the GNOME Shell utilities and retry"
                ;;
            gnome-shell)
                fail "gnome-shell is missing; install GNOME Shell or add its binary to PATH"
                ;;
            gjs)
                fail "gjs is required to validate extension.js with GNOME's JavaScript engine"
                ;;
            *)
                fail "required command not found: $required_command"
                ;;
        esac
    fi
done

SHELL_VERSION_OUTPUT=$(gnome-shell --version 2>&1) ||
    fail "could not query GNOME Shell version: $SHELL_VERSION_OUTPUT"
SHELL_VERSION=$(printf '%s\n' "$SHELL_VERSION_OUTPUT" |
    sed -n 's/^[^0-9]*\([0-9][0-9.]*\).*$/\1/p')

if [ -z "$SHELL_VERSION" ]; then
    fail "could not parse GNOME Shell version output: $SHELL_VERSION_OUTPUT"
fi

if METADATA_INFO=$(python3 - "$METADATA_FILE" "$SHELL_VERSION" <<'PY'
import json
import sys

metadata_path, installed_version = sys.argv[1:]
try:
    with open(metadata_path, encoding="utf-8") as metadata_file:
        metadata = json.load(metadata_file)
except (OSError, json.JSONDecodeError) as error:
    print(f"invalid metadata.json: {error}", file=sys.stderr)
    sys.exit(2)
if not isinstance(metadata, dict):
    print("metadata.json must contain a JSON object", file=sys.stderr)
    sys.exit(2)

uuid = metadata.get("uuid")
name = metadata.get("name")
versions = metadata.get("shell-version")
if not isinstance(uuid, str) or not uuid:
    print("metadata.json has no valid extension UUID", file=sys.stderr)
    sys.exit(2)
if not isinstance(name, str) or not name:
    print("metadata.json has no valid extension name", file=sys.stderr)
    sys.exit(2)
if not isinstance(versions, list) or not all(isinstance(v, str) for v in versions):
    print("metadata.json has no valid shell-version list", file=sys.stderr)
    sys.exit(2)

installed_major = installed_version.split(".", 1)[0]
supported_majors = {version.split(".", 1)[0] for version in versions}
if installed_major not in supported_majors:
    print(
        f"GNOME Shell {installed_version} is unsupported; "
        f"supported versions: {', '.join(versions) or 'none'}",
        file=sys.stderr,
    )
    sys.exit(3)

print(uuid)
print(name)
PY
); then
    :
else
    metadata_status=$?
    case $metadata_status in
        3) fail "this GNOME Shell version is not supported by the extension" ;;
        *) fail "could not validate extension metadata" ;;
    esac
fi

UUID=$(printf '%s\n' "$METADATA_INFO" | sed -n '1p')
EXTENSION_NAME=$(printf '%s\n' "$METADATA_INFO" | sed -n '2p')
case $UUID in
    ''|*[!A-Za-z0-9@._-]*) fail "metadata.json contains an unsafe extension UUID" ;;
esac

info "GNOME Shell $SHELL_VERSION detected"
info "compatibility is checked against the declared GNOME major version"
info "preparing $EXTENSION_NAME ($UUID)"

CURRENT_DESKTOP=${XDG_CURRENT_DESKTOP:-}
SESSION_TYPE=${XDG_SESSION_TYPE:-}
case $CURRENT_DESKTOP:$SESSION_TYPE in
    *GNOME*:wayland|*GNOME*:x11)
        GNOME_SESSION_ACTIVE=1
        info "active GNOME $SESSION_TYPE session detected"
        ;;
    *)
        GNOME_SESSION_ACTIVE=0
        warn "no active GNOME X11/Wayland session detected (XDG_CURRENT_DESKTOP='${CURRENT_DESKTOP:-unset}', XDG_SESSION_TYPE='${SESSION_TYPE:-unset}')"
        warn "installation will continue; activation will be skipped"
        ;;
esac

TEMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/app-grid-only.XXXXXX") ||
    fail "could not create a temporary directory"
STAGED_SOURCE=$TEMP_DIR/source
BUNDLE_DIR=$TEMP_DIR/bundle
mkdir -p "$STAGED_SOURCE" "$BUNDLE_DIR" ||
    fail "could not prepare the temporary build directories"

if ! cp "$EXTENSION_FILE" "$METADATA_FILE" "$STAGED_SOURCE/"; then
    fail "could not stage extension.js and metadata.json"
fi

if command -v node >/dev/null 2>&1; then
    info "validating ES module syntax with Node.js"
    if ! node --check --input-type=module < "$STAGED_SOURCE/extension.js"; then
        fail "JavaScript module syntax validation failed; extension was not installed"
    fi
else
    info "validating ES module syntax with GJS"
    SYNTAX_CHECK_FILE=$TEMP_DIR/extension-syntax-check.js
    if ! python3 - "$STAGED_SOURCE/extension.js" "$SYNTAX_CHECK_FILE" <<'PY'
import re
import sys
from pathlib import Path

source_path, output_path = map(Path, sys.argv[1:])
source = source_path.read_text(encoding="utf-8")
imports = [
    (r"(?m)^import Clutter from ['\"]gi://Clutter';[ \t]*", "const Clutter = {};\n"),
    (r"(?m)^import Meta from ['\"]gi://Meta';[ \t]*", "const Meta = {};\n"),
    (r"(?m)^import \* as Main from ['\"]resource:///org/gnome/shell/ui/main.js';[ \t]*", "const Main = {};\n"),
    (r"(?m)^import \* as OverviewControls from ['\"]resource:///org/gnome/shell/ui/overviewControls.js';[ \t]*", "const OverviewControls = {};\n"),
    (r"(?m)^import \{\s*Extension,\s*InjectionManager,\s*\} from ['\"]resource:///org/gnome/shell/extensions/extension.js';[ \t]*", "class Extension {}\nclass InjectionManager {}\n"),
]

for pattern, replacement in imports:
    source, count = re.subn(pattern, replacement, source)
    if count != 1:
        print(f"Could not prepare module import for parsing: {pattern}", file=sys.stderr)
        sys.exit(1)

if re.search(r"(?m)^import\b", source):
    print("Unhandled module import in extension.js", file=sys.stderr)
    sys.exit(1)

output_path.write_text(source, encoding="utf-8")
PY
    then
        fail "could not prepare the GJS module syntax check"
    fi

    if ! gjs --module "$SYNTAX_CHECK_FILE"; then
        fail "JavaScript module syntax validation failed; extension was not installed"
    fi
fi
info "JavaScript module syntax validation passed"

info "building the extension bundle"
if ! gnome-extensions pack --force --out-dir "$BUNDLE_DIR" "$STAGED_SOURCE"; then
    fail "GNOME failed to build the extension bundle; extension was not installed"
fi

BUNDLE=$BUNDLE_DIR/$UUID.shell-extension.zip
if [ ! -s "$BUNDLE" ]; then
    fail "GNOME did not create the expected extension bundle: $BUNDLE"
fi

info "validating bundle contents"
if ! python3 - "$BUNDLE" "$UUID" <<'PY'
import json
import sys
import zipfile

bundle_path, expected_uuid = sys.argv[1:]
try:
    with zipfile.ZipFile(bundle_path) as bundle:
        bad_file = bundle.testzip()
        if bad_file:
            raise ValueError(f"corrupt file in bundle: {bad_file}")
        names = set(bundle.namelist())
        required = {"metadata.json", "extension.js"}
        if not required.issubset(names):
            raise ValueError("bundle is missing metadata.json or extension.js")
        embedded_metadata = json.loads(bundle.read("metadata.json"))
        if not isinstance(embedded_metadata, dict):
            raise ValueError("embedded metadata.json must contain a JSON object")
        if embedded_metadata.get("uuid") != expected_uuid:
            raise ValueError("bundle UUID does not match metadata.json")
except (OSError, ValueError, zipfile.BadZipFile, json.JSONDecodeError) as error:
    print(f"Invalid extension bundle: {error}", file=sys.stderr)
    sys.exit(1)
PY
then
    fail "extension bundle validation failed; extension was not installed"
fi
info "extension bundle validation passed"

info "installing extension files"
if ! gnome-extensions install --force "$BUNDLE"; then
    fail "installation failed; check the output and ensure your user extension directory is writable"
fi
info "installation complete"

if [ "$GNOME_SESSION_ACTIVE" -ne 1 ]; then
    info "activation skipped because no active GNOME graphical session was detected"
    info "functional test not run; installation alone does not confirm runtime behavior"
    exit 0
fi

info "activating extension in the current GNOME session"
if ! gnome-extensions enable "$UUID"; then
    warn "installation succeeded, but activation failed; the extension remains installed"
    warn "functional test not run; inspect GNOME Shell logs before retrying activation"
    exit 1
fi

info "activation command succeeded"
info "functional test not run; installation and activation do not confirm runtime behavior"
info "if GNOME does not activate it immediately, log out and back in"