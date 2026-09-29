"""At-risk scoring.

Design note on why this is not a supervised classifier: a new deployment has no
labelled dropouts to train on, and by the time it does, the students it would
have helped are already gone. So the model is unsupervised - it clusters the
cohort and flags the cluster whose centroid sits worst on the academic axes.

Crucially, connectivity features (preferred mode, offline ratio, data use) are
deliberately excluded from the clustering. A student on audio-only is not
at risk; they are adapting correctly. Including those features would train the
model to flag poverty instead of difficulty.
"""

import numpy as np
import pandas as pd
from sklearn.cluster import KMeans
from sklearn.preprocessing import StandardScaler

# Only academic-outcome and participation signals feed the model.
RISK_FEATURES = [
    "avg_score",
    "min_score",
    "quizzes_taken",
    "posts",
    "sessions_attended",
    "days_since_activity",
]

# Higher is better for everything except recency of activity.
HIGHER_IS_BETTER = {
    "avg_score": True,
    "min_score": True,
    "quizzes_taken": True,
    "posts": True,
    "sessions_attended": True,
    "days_since_activity": False,
}


def _rule_based(frame: pd.DataFrame) -> pd.DataFrame:
    """Transparent fallback for cohorts too small to cluster meaningfully."""
    out = frame.copy()
    score = np.zeros(len(out))

    score += np.where(out["avg_score"] < 40, 0.35, 0.0)
    score += np.where(out["quizzes_taken"] == 0, 0.25, 0.0)
    score += np.where(out["days_since_activity"] > 14, 0.25, 0.0)
    score += np.where(out["sessions_attended"] == 0, 0.15, 0.0)

    out["risk_score"] = np.clip(score, 0, 1)
    out["method"] = "rule-based"
    return out


def score_cohort(frame: pd.DataFrame) -> pd.DataFrame:
    if frame.empty:
        return frame

    # KMeans on fewer than ~6 students produces clusters that mean nothing.
    if len(frame) < 6:
        return _rule_based(frame)

    features = frame[RISK_FEATURES].astype(float)
    scaled = StandardScaler().fit_transform(features)

    # Never ask for more clusters than there are distinct students. A cohort
    # that all behaves identically has one cluster, not three, and asking for
    # three produces a warning and meaningless splits.
    distinct = len(np.unique(scaled, axis=0))
    k = max(1, min(3, distinct))
    if k == 1:
        out = frame.copy()
        out["cluster"] = 0
        out["risk_score"] = 0.0
        out["method"] = "kmeans"
        return out

    model = KMeans(n_clusters=k, n_init=10, random_state=42)
    labels = model.fit_predict(scaled)

    # Rank clusters by how badly their centroid does on the academic axes,
    # in the scaled space so no single feature dominates by unit.
    centroids = model.cluster_centers_
    goodness = np.zeros(k)
    for idx, feature in enumerate(RISK_FEATURES):
        direction = 1.0 if HIGHER_IS_BETTER[feature] else -1.0
        goodness += direction * centroids[:, idx]

    # Descending, so the best-performing cluster takes position 0 and the
    # worst takes position k-1. Sorting ascending here would invert the scale
    # and hand the struggling cluster a risk score of zero.
    order = np.argsort(-goodness)
    rank = {cluster: position for position, cluster in enumerate(order)}

    out = frame.copy()
    out["cluster"] = labels
    # Worst cluster maps to 1.0, best to 0.0.
    out["risk_score"] = [
        round(rank[label] / max(1, k - 1), 3) if k > 1 else 0.0 for label in labels
    ]
    out["method"] = "kmeans"
    return out


def band(score: float) -> str:
    if score >= 0.66:
        return "high"
    if score >= 0.33:
        return "medium"
    return "low"


def reasons(row: pd.Series) -> list:
    """Plain-language explanation, so a teacher can act without trusting a number."""
    notes = []
    if row["quizzes_taken"] == 0:
        notes.append("has not attempted any quiz")
    elif row["avg_score"] < 40:
        notes.append(f"average score {row['avg_score']:.0f}% is below the pass mark")
    if row["days_since_activity"] > 14:
        notes.append(f"no activity for {int(row['days_since_activity'])} days")
    if row["sessions_attended"] == 0:
        notes.append("has not joined a live session")
    if row["posts"] == 0:
        notes.append("has not posted on the discussion board")

    # Context, never a risk factor in itself.
    if row.get("offline_attempt_ratio", 0) > 0.5:
        notes.append("works mostly offline, so contact by phone may reach them faster")

    return notes or ["no specific concern flagged"]
