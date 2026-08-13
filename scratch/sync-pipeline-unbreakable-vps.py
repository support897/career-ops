import paramiko
import os

host = "107.175.88.18"
user = "root"
password = "20inPG05"
local_dir = "/Users/ilse/career-ops-2"
remote_dir = "/root/career-ops-2"

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(host, port=22, username=user, password=password, timeout=15)

sftp = ssh.open_sftp()
sftp.put(os.path.join(local_dir, "web/src/app/api/pipeline/route.ts"), f"{remote_dir}/web/src/app/api/pipeline/route.ts")
sftp.close()

stdin, stdout, stderr = ssh.exec_command("pm2 restart career-ops-web")
print("PM2 restart output:", stdout.read().decode().strip())

ssh.close()
print("Synced unbreakable pipeline route to VPS successfully!")
