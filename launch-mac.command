#!/bin/bash

# Navigate to the project directory
# NOTE: Replace the path below with the absolute path on your Mac
cd "$(dirname "$0")"

# Start the Next.js server in the background
npm run start &

# Save the process ID to a hidden file so you can kill it later if needed
echo $! > .server.pid

# Wait a few seconds for the server to initialize
sleep 5

# Launch the browser
open "http://localhost:3000"

# Keep the terminal window open to see logs (optional)
# Remove 'read' if you want the window to close immediately
echo "Server is running. Press Ctrl+C in this terminal to stop."
wait
