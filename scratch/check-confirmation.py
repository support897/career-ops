import paramiko

host = "107.175.88.18"
user = "root"
password = "20inPG05"

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(host, port=22, username=user, password=password, timeout=15)

stdin, stdout, stderr = ssh.exec_command("cat /root/career-ops-2/output/confirmation-greenhouse-1786243433584.json")
print("Confirmation JSON:\n", stdout.read().decode().strip())

ssh.close()
