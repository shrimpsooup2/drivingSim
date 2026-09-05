#!/bin/bash
#
# Double-click this file to start the FTC Driving Simulator.
#
# It finds whatever web server tool your computer already has, starts the
# simulator, and opens your browser. Nothing gets installed.
#
# If macOS says it "cannot be opened because it is from an unidentified
# developer", right-click the file and choose Open instead of double-clicking.

cd "$(dirname "$0")" || exit 1

clear
echo ""
echo "  ================================================"
echo "     FTC Driving Simulator"
echo "  ================================================"
echo ""

# Find a port nothing else is using. Someone starting the simulator twice is
# far more likely than a genuine conflict, and "address already in use" is a
# terrible first error message.
find_free_port() {
  local base=$1
  local try
  for offset in $(seq 0 20); do
    try=$((base + offset))
    if ! (exec 3<>"/dev/tcp/127.0.0.1/$try") 2>/dev/null; then
      echo "$try"
      return 0
    fi
  done
  echo "$base"
}

PORT=$(find_free_port 8080)
URL="http://127.0.0.1:$PORT/"

open_browser_soon() {
  ( sleep 1.5; open "$URL" >/dev/null 2>&1 ) &
}

print_running() {
  echo "  The simulator is running at:"
  echo ""
  echo "      $URL"
  echo ""
  echo "  Your browser should open automatically."
  echo ""
  echo "  Leave this window open while you drive."
  echo "  To stop, close this window or press Control-C."
  echo ""
}

# Node is preferred: it runs the project's own server, which opens the browser
# and handles busy ports itself. The others are fallbacks so that a machine
# without Node still works.
if command -v node >/dev/null 2>&1; then
  echo "  Starting (using Node)..."
  echo ""
  exec node tools/serve.js --port "$PORT"

elif command -v python3 >/dev/null 2>&1; then
  echo "  Starting (using Python 3)..."
  echo ""
  print_running
  open_browser_soon
  exec python3 -m http.server "$PORT" --bind 127.0.0.1

elif command -v ruby >/dev/null 2>&1; then
  echo "  Starting (using Ruby)..."
  echo ""
  print_running
  open_browser_soon
  exec ruby -run -e httpd . -p "$PORT" -b 127.0.0.1

elif command -v php >/dev/null 2>&1; then
  echo "  Starting (using PHP)..."
  echo ""
  print_running
  open_browser_soon
  exec php -S "127.0.0.1:$PORT"

else
  echo "  This computer does not have a web server tool installed yet."
  echo ""
  echo "  You have two options:"
  echo ""
  echo "  1. Easiest: use the online version instead. No install needed."
  echo "     Ask your team lead for the link, or see README.md."
  echo ""
  echo "  2. Install Node once, then this file will work forever:"
  echo "     Go to  https://nodejs.org  and download the LTS version."
  echo ""
  echo "  Press Return to close this window."
  read -r _
  exit 1
fi
