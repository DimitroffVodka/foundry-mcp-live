@echo off

REM ---------------------------------------------------------------------------
REM Optional features (env-var gates). Both are off by default.
REM Uncomment WRITE to let tools change the world; uncomment EVAL to add the
REM `evaluate` tool (arbitrary JS in the Foundry browser context).
REM ---------------------------------------------------------------------------
REM set FOUNDRY_MCP_ALLOW_WRITE=1
REM set FOUNDRY_MCP_ALLOW_EVAL=1

echo Starting Foundry MCP Server...
echo MCP endpoint : http://127.0.0.1:3000/mcp
echo Foundry WS   : ws://127.0.0.1:3001
if "%FOUNDRY_MCP_ALLOW_WRITE%"=="1" echo World writes : ENABLED
if "%FOUNDRY_MCP_ALLOW_EVAL%"=="1"  echo evaluate     : ENABLED (arbitrary JS in Foundry context)
echo.
echo Keep this window open while using Claude Desktop or Claude Code CLI.
echo Close it to stop the server.
echo.
node "%~dp0server.js"
pause
