#!/bin/bash
ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i /Users/elf-6/.ssh/remote_access_key root@64.23.238.56 "
echo CPU:\$(top -bn1 | grep 'Cpu(s)' | awk '{print \$2}')%
echo RAM:\$(free -m | awk '/Mem:/{printf \"%d/%dMB\", \$3, \$2}')
echo DISK:\$(df -h / | awk 'NR==2{printf \"%s/%s (%s)\", \$3, \$2, \$5}')
echo UPTIME:\$(uptime -p)
echo N8N:\$(docker inspect -f '{{.State.Running}}' n8n-docker-caddy-n8n-1 2>/dev/null || echo stopped)
echo LOAD:\$(cat /proc/loadavg | awk '{print \$1}')
" 2>/dev/null
