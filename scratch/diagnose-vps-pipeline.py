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

run_cmd("ls -la /root/career-ops-2/data/")
run_cmd("head -n 20 /root/career-ops-2/data/pipeline.md || true")
run_cmd("head -n 20 /root/career-ops-2/data/applications.md || true")
run_cmd("pm2 logs career-ops-web --lines 50 --nostream")

ssh.close()
