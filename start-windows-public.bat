@echo off
rem Same as start-windows.bat, plus a free public link for friends outside your home network.
rem Needs cloudflared: see README.md, section "Playing over the internet".
call "%~dp0start-windows.bat" --public %*
