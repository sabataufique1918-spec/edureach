"""Feature extraction.

Every feature here is chosen to be computable for a student who is mostly
offline. Anything that depends on continuous telemetry would systematically
mark rural students as disengaged simply because their connection is bad,
which is the exact bias this platform exists to avoid.
"""

from datetime import datetime, timedelta, timezone

import pandas as pd
from bson import ObjectId

from .db import get_db


def _oid(value):
    return ObjectId(value) if not isinstance(value, ObjectId) else value


def course_frame(course_id: str) -> pd.DataFrame:
    """One row per enrolled student, with behavioural features."""
    db = get_db()
    cid = _oid(course_id)

    course = db.courses.find_one({"_id": cid})
    if not course:
        return pd.DataFrame()

    student_ids = course.get("enrolled", [])
    if not student_ids:
        return pd.DataFrame()

    students = list(db.users.find({"_id": {"$in": student_ids}}, {"name": 1, "preferredMode": 1}))
    attempts = list(db.quizattempts.find({"course": cid}))
    posts = list(db.discussionposts.find({"course": cid}))
    sessions = list(db.livesessions.find({"course": cid}))

    now = datetime.now(timezone.utc)
    rows = []

    for student in students:
        sid = student["_id"]

        mine = [a for a in attempts if a.get("student") == sid]
        scores = [a.get("percent", 0) for a in mine]
        offline_attempts = sum(1 for a in mine if a.get("takenOffline"))

        my_posts = [p for p in posts if p.get("author") == sid]

        attended = 0
        total_seconds = 0
        for session in sessions:
            for entry in session.get("attendance", []):
                if entry.get("student") == sid:
                    attended += 1
                    total_seconds += entry.get("secondsPresent", 0)

        last_activity = None
        for item in mine + my_posts:
            stamp = item.get("takenAt") or item.get("createdAt")
            if stamp and (last_activity is None or stamp > last_activity):
                last_activity = stamp

        days_since = (
            (now - last_activity.replace(tzinfo=timezone.utc)).days
            if last_activity
            else 999
        )

        rows.append(
            {
                "student_id": str(sid),
                "name": student.get("name", ""),
                "preferred_mode": student.get("preferredMode", "audio"),
                "quizzes_taken": len(mine),
                "avg_score": float(sum(scores) / len(scores)) if scores else 0.0,
                "min_score": float(min(scores)) if scores else 0.0,
                "offline_attempt_ratio": (offline_attempts / len(mine)) if mine else 0.0,
                "posts": len(my_posts),
                "sessions_attended": attended,
                "minutes_live": round(total_seconds / 60, 1),
                "days_since_activity": min(days_since, 365),
            }
        )

    return pd.DataFrame(rows)


def usage_frame(course_id: str) -> pd.DataFrame:
    """Daily data consumption for the students on a course."""
    db = get_db()
    cid = _oid(course_id)

    course = db.courses.find_one({"_id": cid})
    if not course:
        return pd.DataFrame()

    since = (datetime.now(timezone.utc) - timedelta(days=30)).strftime("%Y-%m-%d")
    rows = list(
        db.datausages.find(
            {"user": {"$in": course.get("enrolled", [])}, "day": {"$gte": since}}
        )
    )
    if not rows:
        return pd.DataFrame()

    flat = []
    for row in rows:
        flat.append(
            {
                "student_id": str(row["user"]),
                "day": row["day"],
                "mb": round(row.get("bytes", 0) / 1048576, 3),
                **{
                    f"mb_{mode}": round(byte_count / 1048576, 3)
                    for mode, byte_count in (row.get("byMode") or {}).items()
                },
            }
        )
    return pd.DataFrame(flat)
