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
    if out: print("STDOUT:\n", out[:500])
    if err: print("STDERR:\n", err[:500])
    return out

run_cmd("curl -s http://127.0.0.1:3001/api/pipeline")

ssh.close()
