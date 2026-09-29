"""Tests for the at-risk model.

The property that matters most here is not accuracy, it is fairness: a student
who works offline on audio-only must not be flagged for that. The model is
supposed to find students in academic difficulty, not students on bad
connections.
"""

import pandas as pd

from app.risk import band, reasons, score_cohort


def student(name, **overrides):
    base = {
        "student_id": name.lower(),
        "name": name,
        "preferred_mode": "low",
        "quizzes_taken": 4,
        "avg_score": 75.0,
        "min_score": 65.0,
        "offline_attempt_ratio": 0.0,
        "posts": 3,
        "sessions_attended": 4,
        "minutes_live": 180.0,
        "days_since_activity": 1,
    }
    base.update(overrides)
    return base


passed = 0


def check(name, fn):
    global passed
    fn()
    passed += 1
    print(f"  ok  {name}")


# --------------------------------------------------------------------------

print("\nrisk: small cohorts")


def small_cohort_uses_rules():
    frame = pd.DataFrame([student("Alpha"), student("Beta", avg_score=20.0, quizzes_taken=1)])
    scored = score_cohort(frame)
    assert scored["method"].iloc[0] == "rule-based", "under 6 students must not cluster"
    assert scored.loc[scored["name"] == "Beta", "risk_score"].iloc[0] > 0
    assert scored.loc[scored["name"] == "Alpha", "risk_score"].iloc[0] == 0


check("a cohort under six falls back to transparent rules", small_cohort_uses_rules)


print("\nrisk: fairness")


def offline_students_are_not_flagged():
    # Eight students, identical academically. Four work entirely offline on
    # audio-only over a terrible link; four are on video with good signal.
    rows = []
    for i in range(4):
        rows.append(
            student(
                f"Rural{i}",
                preferred_mode="audio",
                offline_attempt_ratio=1.0,
                sessions_attended=4,
                minutes_live=175.0,
            )
        )
    for i in range(4):
        rows.append(student(f"Urban{i}", preferred_mode="medium", offline_attempt_ratio=0.0))

    scored = score_cohort(pd.DataFrame(rows))
    rural = scored[scored["name"].str.startswith("Rural")]["risk_score"]
    urban = scored[scored["name"].str.startswith("Urban")]["risk_score"]

    assert rural.max() == urban.max(), (
        "students who work offline must not score higher risk than identical "
        f"students on good connections (rural={rural.tolist()}, urban={urban.tolist()})"
    )


check("working offline does not raise a student's risk score", offline_students_are_not_flagged)


def connectivity_is_not_a_feature():
    from app.risk import RISK_FEATURES

    for banned in ("preferred_mode", "offline_attempt_ratio", "mb", "data"):
        assert banned not in RISK_FEATURES, f"{banned} must not feed the model"


check("connectivity signals are excluded from the feature set", connectivity_is_not_a_feature)


print("\nrisk: detection")


def struggling_students_rank_highest():
    rows = [student(f"Doing fine {i}") for i in range(5)]
    rows.append(student("Struggling", avg_score=18.0, min_score=0.0, quizzes_taken=1, posts=0))
    rows.append(
        student("Vanished", avg_score=0.0, min_score=0.0, quizzes_taken=0, posts=0,
                sessions_attended=0, minutes_live=0.0, days_since_activity=40)
    )

    scored = score_cohort(pd.DataFrame(rows)).sort_values("risk_score", ascending=False)
    top_two = set(scored.head(2)["name"])
    assert top_two == {"Struggling", "Vanished"}, f"expected both flagged, got {top_two}"
    assert scored.iloc[0]["risk_score"] > scored.iloc[-1]["risk_score"]


check("students in academic difficulty rank highest", struggling_students_rank_highest)


def bands_split_sensibly():
    assert band(0.9) == "high"
    assert band(0.5) == "medium"
    assert band(0.0) == "low"


check("risk scores map to readable bands", bands_split_sensibly)


print("\nrisk: explanations")


def reasons_are_plain_language():
    row = pd.Series(student("Vanished", quizzes_taken=0, days_since_activity=30,
                            sessions_attended=0, posts=0, avg_score=0.0))
    notes = reasons(row)
    assert any("not attempted any quiz" in n for n in notes)
    assert any("30 days" in n for n in notes)
    assert all(isinstance(n, str) and n for n in notes)


check("every flag comes with a plain-language reason", reasons_are_plain_language)


def offline_note_is_context_not_blame():
    row = pd.Series(student("Rural", offline_attempt_ratio=1.0))
    notes = reasons(row)
    offline_notes = [n for n in notes if "offline" in n]
    assert offline_notes, "the teacher should be told how best to reach them"
    assert "risk" not in offline_notes[0].lower()
    assert "behind" not in offline_notes[0].lower()


check("the offline note reads as context, not as a concern", offline_note_is_context_not_blame)


def healthy_cohort_flags_nobody_as_high():
    rows = [student(f"Student {i}") for i in range(8)]
    scored = score_cohort(pd.DataFrame(rows))
    # Identical students must all land in one cluster and share a score.
    assert scored["risk_score"].nunique() == 1


check("a uniformly healthy cohort is not split into winners and losers",
      healthy_cohort_flags_nobody_as_high)


print(f"\n{passed} tests passed\n")
