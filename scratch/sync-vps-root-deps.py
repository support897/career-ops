import paramiko
import os

host = "107.175.88.18"
user = "root"
password = "20inPG05"
local_dir = "/Users/ilse/career-ops-2"
remote_dir = "/root/career-ops-2"

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(host, port=22, username=user, password=password, timeout=20)

sftp = ssh.open_sftp()
sftp.put(os.path.join(local_dir, "package.json"), f"{remote_dir}/package.json")
sftp.close()

def run_ssh(cmd):
    print(f"=== {cmd} ===")
    stdin, stdout, stderr = ssh.exec_command(cmd)
    out = stdout.read().decode().strip()
    err = stderr.read().decode().strip()
    if out: print("STDOUT:", out)
    if err: print("STDERR:", err)
    return out

run_ssh("cd /root/career-ops-2 && npm install --no-audit --no-fund")
run_ssh("pm2 restart career-ops-web")

ssh.close()
print("VPS root dependencies updated and PM2 restarted!")
