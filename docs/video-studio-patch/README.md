# AI Video Studio: "import into Wayne Ads" endpoint

The ads wizard's **"AI Video Studio se"** button lists the business's finished videos from Video Studio. Video Studio needs one new read-only endpoint for this. This session could only read that repo, so the change is a patch file here.

**Patch:** `0001-wayne-ads-video-link.patch` (for `Wayneesolutions/aivideostudiobackend`, made on main @ a6c3845)
- `app/api/ads_link.py`: `GET /api/v1/hub/videos`. It returns only that business's DONE videos, with absolute URLs.
- `app/core/config.py`: `ADS_LINK_SECRET`, `PUBLIC_BASE_URL`
- `app/main.py`: registers the router
- `tests/test_ads_link.py`: 3 tests. With the patch applied, Video Studio's whole suite passes (43 tests).

**Apply:**
```bash
cd aivideostudiobackend && git checkout -b feature/wayne-ads-video-link
git am /path/to/0001-wayne-ads-video-link.patch
python -m pytest -q
```
Then open a PR in that repo.

**Env:**
- Video Studio: `ADS_LINK_SECRET=<32+ random chars>` and `PUBLIC_BASE_URL=https://aivideo.wayneesolutions.com`
- Wayne Ads: `VIDEO_STUDIO_LINK_SECRET=<same value>` and `VIDEO_STUDIO_API_URL=https://aivideo.wayneesolutions.com`

**Token:** HS256, iss `wayne-ads`, aud `videoStudio`, purpose `list_videos`, sub = Loopdesk business id, single-use jti, 2 min. Both tools know a business by the same `hubBusinessId` because the Loopdesk hub provisions both. A business outside the bundle can still paste a video link in the wizard.
