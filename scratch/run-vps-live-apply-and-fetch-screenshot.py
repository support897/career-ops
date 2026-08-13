import paramiko
import os
import glob

host = "107.175.88.18"
user = "root"
password = "20inPG05"
local_dir = "/Users/ilse/career-ops-2"
remote_dir = "/root/career-ops-2"
artifact_dir = "/Users/ilse/.gemini/antigravity-ide/brain/8c085e45-2059-4d3b-b64b-5bdcd1185607"

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(host, port=22, username=user, password=password, timeout=30)

sftp = ssh.open_sftp()
sftp.put(os.path.join(local_dir, "apply-to-ats.mjs"), f"{remote_dir}/apply-to-ats.mjs")
print("Synced apply-to-ats.mjs to VPS.")

def run_ssh(cmd):
    print(f"=== {cmd} ===")
    stdin, stdout, stderr = ssh.exec_command(cmd)
    out = stdout.read().decode().strip()
    err = stderr.read().decode().strip()
    if out: print("STDOUT:\n", out)
    if err: print("STDERR:\n", err)
    return out

# Execute live application on VPS
cmd_out = run_ssh("cd /root/career-ops-2 && node apply-to-ats.mjs https://job-boards.greenhouse.io/openai/jobs/4320144008 --cv output/cv.pdf")

# Download confirmation screenshots from VPS
remote_files = sftp.listdir(f"{remote_dir}/output")
png_files = [f for f in remote_files if f.endswith(".png")]
json_files = [f for f in remote_files if f.endswith(".json")]

print("Remote PNG screenshots:", png_files)
print("Remote JSON confirmations:", json_files)

for fname in png_files:
    r_path = f"{remote_dir}/output/{fname}"
    l_path = os.path.join(artifact_dir, fname)
    print(f"Downloading {r_path} -> {l_path}")
    sftp.get(r_path, l_path)

sftp.close()
ssh.close()
print("Live test and screenshot download completed!")
