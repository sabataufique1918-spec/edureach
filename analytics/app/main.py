"""EduReach analytics service.

Sits behind the Node API gateway and is never exposed publicly. Authentication
is a shared token rather than a full auth stack, because the only caller is the
gateway running on the same private network.
"""

import os

import pandas as pd
from fastapi import Depends, FastAPI, Header, HTTPException, Query

from .db import get_db
from .features import course_frame, usage_frame
from .risk import band, reasons, score_cohort

app = FastAPI(title="EduReach Analytics", version="1.0.0")


def require_token(x_analytics_token: str = Header(default="")):
    expected = os.getenv("ANALYTICS_TOKEN", "analytics-shared-secret")
    if x_analytics_token != expected:
        raise HTTPException(status_code=401, detail="invalid analytics token")


@app.get("/health")
def health():
    try:
        get_db().command("ping")
        return {"ok": True, "mongo": True}
    except Exception as exc:
        return {"ok": False, "mongo": False, "error": str(exc)}


@app.get("/engagement", dependencies=[Depends(require_token)])
def engagement(course_id: str = Query(..., alias="course_id")):
    frame = course_frame(course_id)
    if frame.empty:
        return {"courseId": course_id, "students": 0, "summary": {}, "rows": []}

    summary = {
        "students": int(len(frame)),
        "avgScore": round(float(frame["avg_score"].mean()), 1),
        "medianScore": round(float(frame["avg_score"].median()), 1),
        "quizParticipationRate": round(
            float((frame["quizzes_taken"] > 0).mean() * 100), 1
        ),
        "liveAttendanceRate": round(
            float((frame["sessions_attended"] > 0).mean() * 100), 1
        ),
        "discussionParticipationRate": round(float((frame["posts"] > 0).mean() * 100), 1),
        "avgMinutesLive": round(float(frame["minutes_live"].mean()), 1),
        # How much of the cohort is working offline. A high number is a
        # success signal for the offline-first design, not a problem.
        "offlineWorkRate": round(float((frame["offline_attempt_ratio"] > 0).mean() * 100), 1),
        "modeMix": frame["preferred_mode"].value_counts().to_dict(),
    }

    return {
        "courseId": course_id,
        "students": int(len(frame)),
        "summary": summary,
        "rows": frame.sort_values("avg_score", ascending=False).to_dict(orient="records"),
    }


@app.get("/at-risk", dependencies=[Depends(require_token)])
def at_risk(course_id: str = Query(..., alias="course_id")):
    frame = course_frame(course_id)
    if frame.empty:
        return {"courseId": course_id, "method": "none", "students": []}

    scored = score_cohort(frame).sort_values("risk_score", ascending=False)

    students = []
    for _, row in scored.iterrows():
        students.append(
            {
                "studentId": row["student_id"],
                "name": row["name"],
                "riskScore": float(row["risk_score"]),
                "band": band(float(row["risk_score"])),
                "reasons": reasons(row),
                "avgScore": round(float(row["avg_score"]), 1),
                "quizzesTaken": int(row["quizzes_taken"]),
                "daysSinceActivity": int(row["days_since_activity"]),
                "preferredMode": row["preferred_mode"],
            }
        )

    return {
        "courseId": course_id,
        "method": str(scored["method"].iloc[0]),
        "note": (
            "Connectivity signals are excluded from the model on purpose: a "
            "student on audio-only is adapting correctly, not falling behind."
        ),
        "counts": {
            "high": sum(1 for s in students if s["band"] == "high"),
            "medium": sum(1 for s in students if s["band"] == "medium"),
            "low": sum(1 for s in students if s["band"] == "low"),
        },
        "students": students,
    }


@app.get("/bandwidth", dependencies=[Depends(require_token)])
def bandwidth(course_id: str = Query(..., alias="course_id")):
    frame = usage_frame(course_id)
    if frame.empty:
        return {"courseId": course_id, "days": 0, "totalMb": 0, "daily": [], "byMode": {}}

    daily = frame.groupby("day")["mb"].sum().reset_index().sort_values("day")
    mode_columns = [c for c in frame.columns if c.startswith("mb_")]
    by_mode = {c[3:]: round(float(frame[c].sum()), 2) for c in mode_columns}

    per_student = frame.groupby("student_id")["mb"].sum()

    return {
        "courseId": course_id,
        "days": int(daily.shape[0]),
        "totalMb": round(float(frame["mb"].sum()), 2),
        "avgMbPerStudent": round(float(per_student.mean()), 2),
        "p90MbPerStudent": round(float(per_student.quantile(0.9)), 2),
        "byMode": by_mode,
        "daily": [
            {"day": r["day"], "mb": round(float(r["mb"]), 2)}
            for _, r in daily.iterrows()
        ],
    }
