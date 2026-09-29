"""Read-only Mongo access for the analytics service.

This service never writes. It reads the same collections the API owns and
returns derived numbers, which keeps the schema in exactly one place and means
a bug here can never corrupt academic data.
"""

import os
from functools import lru_cache

from pymongo import MongoClient


@lru_cache(maxsize=1)
def get_db():
    uri = os.getenv("MONGO_URI", "mongodb://localhost:27017/edureach")
    client = MongoClient(uri, serverSelectionTimeoutMS=8000)
    # The database name is carried in the URI; fall back to the default.
    name = uri.rsplit("/", 1)[-1].split("?")[0] or "edureach"
    return client[name]
