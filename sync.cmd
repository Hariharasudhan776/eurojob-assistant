@echo off
REM Auto-run for eurojob-assistant, daily at 07:00 via Task Scheduler
REM ("EuroJob Daily Sync"). Runs the agent against the live Neon database
REM (DATABASE_URL in .env): collect + score for every user + write in-app
REM notifications for new top matches. Free: no AI is ever called here.
cd /d C:\Users\ITS44\Desktop\Work\eurojob-assistant
echo ==== agent started %DATE% %TIME% ==== >> sync.log
call npm run agent >> sync.log 2>&1
echo ==== agent finished %DATE% %TIME% ==== >> sync.log
