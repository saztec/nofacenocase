"""
NoFaceNoCase — the actual backend.

One Lambda, one router. API Gateway sends everything here via ANY /{proxy+}
and this figures out what to do with it. Talks to DynamoDB for the data,
Rekognition for faces, Comprehend for sentiment, SNS for distress alerts.

Env vars it expects (set these in the Lambda console):
  PATIENTS_TABLE, CHECKINS_TABLE, MEDS_TABLE, PHOTO_BUCKET, SNS_TOPIC_ARN
  CUSTOM_LABELS_ARN  (optional) — ProjectVersion ARN of the trained
                      Rekognition Custom Labels bed-occupancy model. Must be
                      a STARTED model for /analyse/bed to work.
"""

import base64
import decimal
import json
import os
import uuid
from datetime import datetime, timezone

import boto3
from boto3.dynamodb.conditions import Key

PATIENTS_TABLE = os.environ["PATIENTS_TABLE"]
CHECKINS_TABLE = os.environ["CHECKINS_TABLE"]
MEDS_TABLE = os.environ["MEDS_TABLE"]
PHOTO_BUCKET = os.environ["PHOTO_BUCKET"]
SNS_TOPIC_ARN = os.environ["SNS_TOPIC_ARN"]
ALERT_THRESHOLD = float(os.environ.get("ALERT_THRESHOLD", "80"))
# ProjectVersion ARN of the trained bed-occupancy model. Optional so the rest
# of the API keeps working even when the (billed) model is stopped.
CUSTOM_LABELS_ARN = os.environ.get("CUSTOM_LABELS_ARN", "")

ddb = boto3.resource("dynamodb")
s3 = boto3.client("s3")
rekognition = boto3.client("rekognition")
comprehend = boto3.client("comprehend")
sns = boto3.client("sns")

patients_t = ddb.Table(PATIENTS_TABLE)
checkins_t = ddb.Table(CHECKINS_TABLE)
meds_t = ddb.Table(MEDS_TABLE)

NEGATIVE_EMOTIONS = {"SAD", "FEAR", "ANGRY", "DISGUSTED"}


class DecimalEncoder(json.JSONEncoder):
    """DynamoDB hands back Decimals and json.dumps hates them."""
    def default(self, o):
        if isinstance(o, decimal.Decimal):
            return int(o) if o % 1 == 0 else float(o)
        return super().default(o)


def respond(status, body):
    # CORS headers come from the API Gateway CORS config, not here
    return {
        "statusCode": status,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps(body, cls=DecimalEncoder),
    }


def clean(obj):
    """Floats aren't allowed in DynamoDB — swap them for Decimal."""
    if isinstance(obj, float):
        return decimal.Decimal(str(obj))
    if isinstance(obj, list):
        return [clean(v) for v in obj]
    if isinstance(obj, dict):
        return {k: clean(v) for k, v in obj.items()}
    return obj


def body_of(event):
    raw = event.get("body") or "{}"
    if event.get("isBase64Encoded"):
        raw = base64.b64decode(raw).decode("utf-8")
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return {}


def groups_of(event):
    """Pull the Cognito groups out of the JWT so we can check roles."""
    try:
        claims = event["requestContext"]["authorizer"]["jwt"]["claims"]
    except KeyError:
        return []
    raw = claims.get("cognito:groups", [])
    if isinstance(raw, list):
        return raw
    # sometimes it arrives as the string "[nurse clinician]"
    return raw.strip("[]").replace(",", " ").split()


def today():
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def lambda_handler(event, context):
    method = event["requestContext"]["http"]["method"]

    # CORS preflight: answer OPTIONS before any routing so the browser's
    # pre-check always gets a 200 (the JWT authorizer lets OPTIONS through
    # via its own no-auth route on API Gateway).
    if method == "OPTIONS":
        return respond(200, {})

    path = event["requestContext"]["http"]["path"].rstrip("/") or "/"
    parts = [p for p in path.split("/") if p]

    try:
        return route(method, parts, event)
    except Exception as exc:  # noqa: BLE001 — surface the error instead of a bare 502
        print("ERROR:", repr(exc))
        return respond(500, {"success": False, "message": str(exc)})


def route(method, parts, event):
    # /patients ...
    if parts and parts[0] == "patients":
        if len(parts) == 1:
            if method == "GET":
                return list_patients()
            if method == "POST":
                return create_patient(body_of(event))

        if len(parts) == 2:
            pid = parts[1]
            if method == "GET":
                return get_patient(pid)
            if method == "PUT":
                return update_patient(pid, body_of(event))
            if method == "DELETE":
                return delete_patient(pid, event)

        if len(parts) == 3 and parts[2] == "checkins" and method == "GET":
            return list_checkins(parts[1])

        if len(parts) == 3 and parts[2] == "medications" and method == "GET":
            return list_medications(parts[1])

    if parts == ["checkins"] and method == "POST":
        return create_checkin(body_of(event))

    if parts == ["analyse", "image"] and method == "POST":
        return analyse_image(body_of(event))

    if parts == ["analyse", "bed"] and method == "POST":
        return analyse_bed(body_of(event))

    if parts == ["analyse", "sentiment"] and method == "POST":
        return analyse_sentiment(body_of(event))

    if parts == ["alerts"] and method == "POST":
        return send_alert(body_of(event))

    if parts == ["admin", "seed"] and method == "POST":
        return seed()

    return respond(404, {"success": False, "message": f"No route for {method} /{'/'.join(parts)}"})


# patients

def list_patients():
    items = patients_t.scan().get("Items", [])
    items.sort(key=lambda p: p.get("patientId", ""))
    return respond(200, {"success": True, "patients": items})


def get_patient(pid):
    item = patients_t.get_item(Key={"patientId": pid}).get("Item")
    if not item:
        return respond(404, {"success": False, "message": "Patient not found."})
    return respond(200, {"success": True, "patient": item})


def next_patient_id():
    items = patients_t.scan(ProjectionExpression="patientId").get("Items", [])
    nums = []
    for it in items:
        try:
            nums.append(int(str(it["patientId"]).split("-")[1]))
        except (IndexError, ValueError):
            pass
    return "P-" + str(max(nums) + 1 if nums else 1001)


def create_patient(data):
    patient = {
        "patientId": next_patient_id(),
        "status": "Admitted",
        "admitted": today(),
        "monitoring": {
            "sleepHours": 7.0, "sleepQuality": "Fair", "movement": "Moderate",
            "dayActiveHrs": 8.0, "nightActiveHrs": 1.0, "bedExitsNight": 0, "highRisk": False,
        },
    }
    patient.update({k: v for k, v in data.items() if k != "patientId"})
    patients_t.put_item(Item=clean(patient))
    return respond(201, {"success": True, "patient": patient})


def update_patient(pid, updates):
    existing = patients_t.get_item(Key={"patientId": pid}).get("Item")
    if not existing:
        return respond(404, {"success": False, "message": "Patient not found."})
    existing.update({k: v for k, v in updates.items() if k != "patientId"})
    patients_t.put_item(Item=clean(existing))
    return respond(200, {"success": True, "patient": existing})


def delete_patient(pid, event):
    # only clinicians get to delete records
    if "clinician" not in groups_of(event):
        return respond(403, {"success": False, "message": "Only clinicians can delete a patient."})

    patients_t.delete_item(Key={"patientId": pid})

    # clear out their check-ins and meds too
    for table, sort_key in ((checkins_t, "checkinId"), (meds_t, "medId")):
        rows = table.query(KeyConditionExpression=Key("patientId").eq(pid)).get("Items", [])
        with table.batch_writer() as batch:
            for row in rows:
                batch.delete_item(Key={"patientId": pid, sort_key: row[sort_key]})

    return respond(200, {"success": True, "deleted": pid})


# check-ins and meds

def list_checkins(pid):
    rows = checkins_t.query(KeyConditionExpression=Key("patientId").eq(pid)).get("Items", [])
    rows.sort(key=lambda c: c.get("date", ""))
    return respond(200, {"success": True, "checkins": rows})


def list_medications(pid):
    rows = meds_t.query(KeyConditionExpression=Key("patientId").eq(pid)).get("Items", [])
    rows.sort(key=lambda m: m.get("date", ""))
    return respond(200, {"success": True, "medications": rows})


def create_checkin(data):
    checkin = {
        "checkinId": "C-" + uuid.uuid4().hex[:10],
        "date": data.get("date") or today(),
    }
    checkin.update(data)
    if not checkin.get("patientId"):
        return respond(400, {"success": False, "message": "patientId is required."})
    checkins_t.put_item(Item=clean(checkin))
    return respond(201, {"success": True, "checkin": checkin})


# the AI bits

def analyse_image(data):
    """base64 image in, emotions out. Also parks the photo in S3."""
    b64 = data.get("imageBase64", "")
    if "," in b64:  # strip the data:image/jpeg;base64, prefix
        b64 = b64.split(",", 1)[1]
    if not b64:
        return respond(400, {"success": False, "message": "imageBase64 is required."})

    image_bytes = base64.b64decode(b64)
    key = f"checkins/{data.get('patientId', 'unknown')}/{uuid.uuid4().hex}.jpg"

    s3.put_object(
        Bucket=PHOTO_BUCKET, Key=key, Body=image_bytes,
        ContentType="image/jpeg", ServerSideEncryption="AES256",
    )

    result = rekognition.detect_faces(
        Image={"S3Object": {"Bucket": PHOTO_BUCKET, "Name": key}},
        Attributes=["ALL"],
    )

    details = result.get("FaceDetails", [])
    if not details:
        return respond(200, {
            "success": True, "s3Key": key,
            "rekognition": {"FaceDetails": []},
            "message": "No face detected in that photo.",
        })

    emotions = sorted(details[0].get("Emotions", []), key=lambda e: e["Confidence"], reverse=True)
    landmarks = details[0].get("Landmarks", [])

    return respond(200, {
        "success": True,
        "s3Key": key,
        "rekognition": {"FaceDetails": [{"Emotions": emotions, "Landmarks": landmarks}]},
    })


def analyse_bed(data):
    """base64 image in → occupied / empty, using our own trained model.

    This is object detection, not whole-image classification: the model was
    trained on a single label, "occupant", drawn as a bounding box around
    the person in each occupied training photo (empty-bed photos carry no
    annotation and serve as negative examples). At inference time, Rekognition
    hands back the bounding box's pixel-ratio coordinates itself — nothing
    is computed or typed in by hand on our end, in training or here.

    detect_custom_labels only works while the model is STARTED, so we fail
    loudly and clearly if it isn't configured or running rather than
    pretending we got a result."""
    if not CUSTOM_LABELS_ARN:
        return respond(503, {"success": False, "modelReady": False,
                             "message": "Bed-occupancy model not configured (CUSTOM_LABELS_ARN unset)."})

    b64 = data.get("imageBase64", "")
    if "," in b64:
        b64 = b64.split(",", 1)[1]
    if not b64:
        return respond(400, {"success": False, "message": "imageBase64 is required."})

    image_bytes = base64.b64decode(b64)
    key = f"bedchecks/{data.get('patientId', 'unknown')}/{uuid.uuid4().hex}.jpg"
    s3.put_object(
        Bucket=PHOTO_BUCKET, Key=key, Body=image_bytes,
        ContentType="image/jpeg", ServerSideEncryption="AES256",
    )

    try:
        result = rekognition.detect_custom_labels(
            ProjectVersionArn=CUSTOM_LABELS_ARN,
            Image={"S3Object": {"Bucket": PHOTO_BUCKET, "Name": key}},
            # the model's own "assumed threshold" (8%) is too permissive for
            # this dataset size — real test photos showed a genuine occupied
            # bed scoring 21.4% and a rumpled-but-empty bed (deep shadow/fold
            # pattern resembling a body) scoring 13.6%. Set just above the
            # false-positive score, comfortably below the true-positive one.
            # Re-check this value any time you retrain — a new version can
            # shift these numbers.
            MinConfidence=17,
        )
    except rekognition.exceptions.ResourceNotReadyException:
        # the model exists but isn't started — the one runtime gotcha worth
        # surfacing plainly so the demo-day fix is obvious
        return respond(503, {"success": False, "modelReady": False,
                             "message": "Bed-occupancy model is not running. Start it in the Rekognition console, then retry."})

    labels = sorted(result.get("CustomLabels", []), key=lambda l: l.get("Confidence", 0), reverse=True)
    # the model only ever emits "occupant" when it finds one — no detection
    # at all (empty list) is exactly how an empty bed reads
    occupant = next((l for l in labels if l["Name"].lower() in ("occupant", "person", "occupied")), None)
    occupied = occupant is not None

    bounding_box = None
    if occupant and occupant.get("Geometry", {}).get("BoundingBox"):
        bb = occupant["Geometry"]["BoundingBox"]  # Left/Top/Width/Height, all 0–1 ratios of the image
        bounding_box = {"left": bb["Left"], "top": bb["Top"], "width": bb["Width"], "height": bb["Height"]}

    return respond(200, {
        "success": True,
        "modelReady": True,
        "s3Key": key,
        "occupied": occupied,
        "customLabels": [{"Name": l["Name"], "Confidence": round(l.get("Confidence", 0), 1)} for l in labels],
        "top": {"Name": occupant["Name"], "Confidence": round(occupant["Confidence"], 1)} if occupant else None,
        "boundingBox": bounding_box,
    })


def analyse_sentiment(data):
    text = (data.get("text") or "").strip()
    if not text:
        return respond(200, {"success": True, "comprehend": {
            "Sentiment": "NEUTRAL",
            "SentimentScore": {"Positive": 0, "Negative": 0, "Neutral": 1, "Mixed": 0},
        }})

    result = comprehend.detect_sentiment(Text=text[:4500], LanguageCode="en")
    return respond(200, {"success": True, "comprehend": {
        "Sentiment": result["Sentiment"],
        "SentimentScore": result["SentimentScore"],
    }})


def send_alert(data):
    pid = data.get("patientId", "unknown")
    emotion = data.get("emotion") or {}
    etype = emotion.get("Type", "UNKNOWN")
    conf = float(emotion.get("Confidence", 0))

    patient = patients_t.get_item(Key={"patientId": pid}).get("Item") or {}
    name = patient.get("name", pid)
    clinician = patient.get("clinician", "the assigned clinician")

    summary = (f"Alert sent to {clinician}: {etype} detected at {conf:.1f}% "
               f"confidence for patient {name} ({pid}).")

    result = sns.publish(
        TopicArn=SNS_TOPIC_ARN,
        Subject=f"NFNC distress alert — {name}",
        Message=(f"{summary}\n\nPatient: {name} ({pid})\nWard: {patient.get('ward','-')}\n"
                 f"Emotion: {etype} at {conf:.1f}%\nTime: {datetime.now(timezone.utc).isoformat()}\n\n"
                 "Please review this patient."),
    )

    return respond(200, {"success": True, "sns": {
        "MessageId": result["MessageId"],
        "Topic": SNS_TOPIC_ARN,
        "Summary": summary,
    }})


# one-time demo data loader

SEED_PATIENTS = [
    {"patientId": "P-1001", "name": "Tan Wei Ming", "age": 34, "ward": "Ward 3A",
     "condition": "Generalised anxiety", "clinician": "Dr. Aisha Rahman",
     "admitted": "2026-05-12", "status": "Admitted",
     "monitoring": {"sleepHours": 6.2, "sleepQuality": "Fair", "movement": "Moderate",
                    "dayActiveHrs": 8.5, "nightActiveHrs": 1.1, "bedExitsNight": 1, "highRisk": False}},
    {"patientId": "P-1002", "name": "Nurul Izzah", "age": 27, "ward": "Ward 3A",
     "condition": "Major depressive disorder", "clinician": "Dr. Aisha Rahman",
     "admitted": "2026-05-30", "status": "Observation",
     "monitoring": {"sleepHours": 5.0, "sleepQuality": "Poor", "movement": "Low",
                    "dayActiveHrs": 6.0, "nightActiveHrs": 1.6, "bedExitsNight": 1, "highRisk": False}},
    {"patientId": "P-1003", "name": "Marcus Lee", "age": 45, "ward": "Ward 2B",
     "condition": "PTSD", "clinician": "Dr. Kevin Ong",
     "admitted": "2026-06-03", "status": "Admitted",
     "monitoring": {"sleepHours": 4.3, "sleepQuality": "Poor", "movement": "Restless",
                    "dayActiveHrs": 7.5, "nightActiveHrs": 2.4, "bedExitsNight": 3, "highRisk": False}},
    {"patientId": "P-1004", "name": "Priya Nair", "age": 52, "ward": "Ward 2B",
     "condition": "Depression (recurrent)", "clinician": "Dr. Kevin Ong",
     "admitted": "2026-06-11", "status": "Observation",
     "monitoring": {"sleepHours": 7.4, "sleepQuality": "Good", "movement": "Active",
                    "dayActiveHrs": 9.5, "nightActiveHrs": 0.6, "bedExitsNight": 0, "highRisk": False}},
    {"patientId": "P-1005", "name": "Daniel Chua", "age": 19, "ward": "Ward 4C",
     "condition": "Adjustment disorder", "clinician": "Dr. Aisha Rahman",
     "admitted": "2026-06-20", "status": "Admitted",
     "monitoring": {"sleepHours": 6.8, "sleepQuality": "Fair", "movement": "Moderate",
                    "dayActiveHrs": 8.0, "nightActiveHrs": 0.9, "bedExitsNight": 1, "highRisk": False}},
    {"patientId": "P-1006", "name": "Rosnah Bte Yusof", "age": 78, "ward": "Ward 4C",
     "condition": "Dementia (fall risk)", "clinician": "Dr. Kevin Ong",
     "admitted": "2026-06-15", "status": "Admitted",
     "monitoring": {"sleepHours": 3.8, "sleepQuality": "Poor", "movement": "Restless",
                    "dayActiveHrs": 5.5, "nightActiveHrs": 3.9, "bedExitsNight": 5, "highRisk": True}},
]

SEED_CHECKINS = [
    ("C-9001", "P-1001", "2026-06-22", 4, "Patient reports poor sleep, worried about discharge planning.", "CALM", 71.2, "NEGATIVE", False, "SN Farah"),
    ("C-9002", "P-1001", "2026-06-26", 5, "Slightly better after family visit. Engaged in group activity.", "HAPPY", 63.8, "MIXED", False, "SN Farah"),
    ("C-9003", "P-1001", "2026-07-01", 6, "Calm this morning, appetite improving.", "CALM", 88.4, "POSITIVE", False, "SN Lim"),
    ("C-9004", "P-1002", "2026-06-24", 3, "Withdrawn during breakfast, minimal eye contact.", "SAD", 91.6, "NEGATIVE", True, "SN Lim"),
    ("C-9005", "P-1002", "2026-06-29", 4, "Attended art therapy, briefly participated.", "SAD", 67.0, "MIXED", False, "SN Farah"),
    ("C-9006", "P-1002", "2026-07-03", 5, "Initiated conversation with roommate. Small improvement.", "CALM", 74.9, "POSITIVE", False, "SN Lim"),
    ("C-9007", "P-1003", "2026-06-25", 6, "Stable, discussed coping strategies during rounds.", "CALM", 82.3, "POSITIVE", False, "SN Kumar"),
    ("C-9008", "P-1003", "2026-07-02", 4, "Startled response overnight, reported nightmares.", "FEAR", 84.7, "NEGATIVE", True, "SN Kumar"),
    ("C-9009", "P-1004", "2026-06-28", 7, "Positive session with clinician, looking forward to home leave.", "HAPPY", 90.1, "POSITIVE", False, "SN Farah"),
    ("C-9010", "P-1005", "2026-07-04", 5, "Settling into ward routine, mild homesickness.", "CALM", 69.5, "MIXED", False, "SN Lim"),
    ("C-9011", "P-1006", "2026-06-30", 4, "Disoriented in the evening, wandered toward the ward exit.", "FEAR", 81.0, "NEGATIVE", True, "SN Kumar"),
    ("C-9012", "P-1006", "2026-07-04", 3, "Left bed 5 times overnight, calling out, not oriented to place.", "FEAR", 86.5, "NEGATIVE", True, "SN Lim"),
]

SEED_MEDS = [
    {"medId": "M-01", "patientId": "P-1001", "name": "Zolpidem 10mg (sleep)", "date": "2026-06-24", "by": "Dr. Aisha Rahman"},
    {"medId": "M-02", "patientId": "P-1002", "name": "Sertraline 50mg", "date": "2026-06-27", "by": "Dr. Aisha Rahman"},
]


def seed():
    """Fills the tables with the demo ward. Safe to run more than once."""
    with patients_t.batch_writer() as batch:
        for p in SEED_PATIENTS:
            batch.put_item(Item=clean(p))

    with checkins_t.batch_writer() as batch:
        for cid, pid, date, mood, notes, etype, conf, sentiment, alert, staff in SEED_CHECKINS:
            batch.put_item(Item=clean({
                "checkinId": cid, "patientId": pid, "date": date, "mood": mood,
                "notes": notes, "emotion": {"Type": etype, "Confidence": conf},
                "sentiment": sentiment, "alertSent": alert, "staff": staff,
            }))

    with meds_t.batch_writer() as batch:
        for m in SEED_MEDS:
            batch.put_item(Item=clean(m))

    return respond(200, {"success": True, "seeded": {
        "patients": len(SEED_PATIENTS),
        "checkins": len(SEED_CHECKINS),
        "medications": len(SEED_MEDS),
    }})
