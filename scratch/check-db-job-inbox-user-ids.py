import psycopg2

db_url = "postgresql://neondb_owner:npg_oN60DfjuHaVl@ep-patient-sound-ausuu589.c-10.us-east-1.aws.neon.tech/neondb?sslmode=require"
conn = psycopg2.connect(db_url)
cur = conn.cursor()

cur.execute("SELECT DISTINCT user_id, COUNT(*) FROM job_inbox GROUP BY user_id;")
rows = cur.fetchall()
print("JOB INBOX USER_ID COUNTS:")
for r in rows:
    print(r)

cur.execute("SELECT DISTINCT user_id, COUNT(*) FROM applications GROUP BY user_id;")
rows_app = cur.fetchall()
print("APPLICATIONS USER_ID COUNTS:")
for r in rows_app:
    print(r)

cur.close()
conn.close()
