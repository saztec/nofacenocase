# Phase 5.5 — Train a Custom Model (Rekognition Custom Labels)

**Goal:** train your *own* image-classification model that decides whether a hospital bed is
**occupied** or **empty**, then wire it into the bed-check feature. This is a genuinely trained
model — you provide labelled data, AWS runs a training job, and you get accuracy metrics — and it
stays entirely inside AWS (Rekognition family), so it satisfies "use AWS exclusively."

It sits alongside the built-in `detect_faces()` emotion analysis; it does **not** replace it.

---

## Why this design

- **Occupied vs empty bed** needs a model that base Rekognition doesn't have — so training is
  justified, not busywork.
- It **extends the bed-check feature** you already built: instead of "is a face visible," the check
  now asks a purpose-trained model "is this bed occupied," which is more accurate and tells a clean
  wandering-/fall-risk story.
- No real patient faces needed — bed photos are easy to source and carry far less privacy weight.

---

## Cost & time — read first

- **Training** is billed per training-hour (a small one-off; a tiny dataset trains in well under an
  hour).
- **Inference** is billed *per hour the model is RUNNING* — roughly a few dollars/hour. The model
  only works while "Started."
- **You must STOP the model** when you're not testing or demoing, or it quietly runs up a bill.
  Start it → test/demo → stop it. Budget a few single dollars total if you stop it promptly.

---

## Step 1 — Gather the dataset

You need two folders of images:

- `occupied/` — a bed with a person lying/sitting in it. Aim for **~15–20 images**.
- `empty/`    — the same/similar bed made up and empty. Aim for **~15–20 images**.

Tips that make the model actually work:
- Vary angle, distance, lighting, and blanket/pillow arrangement so it learns "person present," not
  one exact pose.
- Phone photos of a real bed (yours, with a consenting volunteer) are the cleanest source — your own
  data, no licensing or privacy issues, and honest to talk about in the viva.
- Keep the two classes visually balanced (similar backgrounds) so the model learns occupancy, not
  "this room = occupied."

---

## Step 2 — Create the project & dataset

This is **object detection**, not whole-image classification: instead of tagging each photo
`occupied`/`empty`, you draw a **bounding box** around the person in each occupied photo.
Rekognition's labeling tool captures the pixel coordinates itself when you drag the box — you
never type or compute a coordinate by hand, in training or at inference time.

1. AWS Console → **Rekognition** → left sidebar **Custom Labels**.
2. If prompted, let it **create the Custom Labels S3 bucket** (accept the default name).
3. **Projects → Create project** → name it `nfnc-bed-occupancy` → Create.
4. **Datasets → Create dataset**:
   - Choose **Start with a single dataset** (Custom Labels auto-splits a test set at training time).
   - **Upload images from your computer** → upload all `occupied/` and `empty/` images.
5. **Label the images**:
   - Add **one** label: `occupant`.
   - Open each *occupied* photo → select the `occupant` label → switch the tool to
     **bounding box** → drag a rectangle around the person. Save. Repeat for every occupied photo.
   - Leave every *empty* photo **completely unlabeled** — no box, no tag. These are your negative
     examples; they teach the model what "nobody here" looks like.
   - Save the dataset.

> **Why this beats two whole-image labels:** the model learns to actually find a person-shaped
> region, not just guess from lighting/background. It also means at inference time Rekognition
> hands back the exact pixel-ratio box it detected — genuinely useful pixel coordinates, computed
> by the trained model, not typed in by you.

---

## Step 3 — Train

1. On the project page → **Train model** → confirm the dataset → **Train**.
2. Walk away — this runs on AWS's clock (typically 30 min to a couple of hours for a small set).
   **Do the code/console steps below while it trains.**
3. When it finishes, open the model → **Evaluation results**. Screenshot the **F1 score, precision,
   and recall** — that's gold for the report's "development process" section.

---

## Step 4 — Start the model & copy its ARN

1. On the trained model page → **Start model** (pick the minimum inference units = 1).
2. Wait until status = **RUNNING**.
3. Copy the **ARN** shown for this model version — it looks like:
   `arn:aws:rekognition:ap-southeast-2:ACCOUNT_ID:project/nfnc-bed-occupancy/version/nfnc-bed-occupancy.2026-08-12T.../123456789`
   This is the **ProjectVersion ARN** — you need it in the next step.

---

## Step 5 — Give the Lambda access + the ARN

**IAM permission** (already in `aws/nfnc-lambda-policy.json`): the Lambda's role needs
`rekognition:DetectCustomLabels`. In the IAM console, open the Lambda's execution role policy and
confirm that action is present in the Rekognition statement (add it if you're editing the live
policy by hand).

**Environment variable:** Lambda console → your `nfnc-api` function → **Configuration → Environment
variables → Edit → Add**:
- Key: `CUSTOM_LABELS_ARN`
- Value: *(paste the ProjectVersion ARN from Step 4)*

Save.

---

## Step 6 — Deploy the updated Lambda code

The backend now has a `/analyse/bed` route and an `analyse_bed()` handler (already written into
`aws/lambda_function.py`). Copy the **full** updated file contents → paste into the Lambda console
Code editor → **Deploy**.

(If `CUSTOM_LABELS_ARN` is ever unset or the model is stopped, `/analyse/bed` returns a clear 503
"model not running" message instead of failing silently — so the rest of the app keeps working.)

---

## Step 7 — Test the bed check

1. Serve the site (`http://localhost:8000` or your CloudFront URL) and open a patient page.
2. Scroll to **Bed status → Check if patient is in bed → Run check**.
3. Point the camera at an occupied vs empty bed image/scene:
   - **Occupied** → green "Bed reads occupied (occupant NN%)", with the captured photo shown and a
     red box drawn over exactly where the model detected the person.
   - **Empty** → amber "Bed reads empty" + a logged bed exit, which updates the triage panel, and
     fires an SNS alert once overnight exits cross the high-risk threshold.

If you get "model is not running," go back to Step 4 and confirm status = RUNNING.

---

## Step 8 — STOP the model (do not skip)

Rekognition console → your model → **Stop model**. Billing for inference stops immediately. Restart
it only when you need to demo. This one habit is the difference between a few cents and a surprise
bill.

---

## Report / viva talking points

- **What you trained:** a custom object-detection model (a single `occupant` label, bounding-box
  annotated) on Rekognition Custom Labels, from your own labelled dataset of ~30–40 images —
  positive examples with a drawn box around the person, negative examples (empty-bed photos) with
  no annotation at all.
- **How it differs from base Rekognition:** `detect_faces` / `detect_sentiment` are Amazon's
  pre-trained managed models you call as-is; this is a model *you* trained on *your* data, for a
  task the base service doesn't cover, down to localising *where in the frame* the detection is.
- **Pixel coordinates:** the bounding box (Left/Top/Width/Height, as 0–1 ratios of the image) comes
  straight back from `DetectCustomLabels` — the frontend draws it as a red box over the captured
  photo, so you can visually show the marker exactly what the model found.
- **Metrics:** quote the F1/precision/recall from Step 3 — shows you evaluated it, not just built it.
- **Integration:** it drives the bed-check → bed-exit → triage → SNS-alert chain, so it adds real
  functional value, not a bolt-on.
- **Honesty note worth stating:** small dataset, so it's a proof-of-concept classifier; a production
  version would need far more varied data. Saying this yourself reads as maturity, not weakness.
