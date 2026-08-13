import paramiko

host = "107.175.88.18"
user = "root"
password = "20inPG05"

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(host, port=22, username=user, password=password, timeout=15)

def run_cmd(cmd):
    print(f"=== {cmd} ===")
    stdin, stdout, stderr = ssh.exec_command(cmd)
    out = stdout.read().decode().strip()
    err = stderr.read().decode().strip()
    if out: print("STDOUT:\n", out)
    if err: print("STDERR:\n", err)
    return out

# Ensure PM2 app career-ops-web is running cleanly
run_cmd("pm2 delete career-ops-web || true")
run_cmd("cd /root/career-ops-2/web && pm2 start npm --name 'career-ops-web' -- run dev -- -p 3001")
run_cmd("pm2 save")

ssh.close()
print("VPS fast server restarted successfully.")
