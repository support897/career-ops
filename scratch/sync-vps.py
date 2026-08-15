import paramiko

host = "107.175.88.18"
user = "root"
password = "20inPG05"
remote_dir = "/root/career-ops-2"

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(host, port=22, username=user, password=password, timeout=30)

sftp = ssh.open_sftp()

files_to_sync = [
    "web/src/app/api/status/route.ts",
    "web/src/components/report-view.tsx",
    "web/src/app/pipeline/[id]/page.tsx",
    "web/src/app/api/pipeline/route.ts",
    "auto-apply.mjs",
    "lib/cv-generator.mjs"
]

for f in files_to_sync:
    try:
        # Create directories if they don't exist
        dir_name = "/".join(f.split("/")[:-1])
        ssh.exec_command(f"mkdir -p {remote_dir}/{dir_name}")
        
        sftp.put(f"/Users/ilse/career-ops-2/{f}", f"{remote_dir}/{f}")
        print(f"Synced: {f}")
    except Exception as e:
        print(f"Failed to sync {f}: {e}")

sftp.close()

def run_cmd(cmd):
    _, stdout, stderr = ssh.exec_command(cmd)
    print(stdout.read().decode().strip())
    print(stderr.read().decode().strip())

print("\n--- PM2 restart ---")
run_cmd("cd /root/career-ops-2 && pm2 restart all")
ssh.close()
print("Done.")
