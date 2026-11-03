# Streaming a protest to YouTube live

Every protest has its own live slot and its own KPI overlay. The overlay is a plain web page, so
any broadcast tool that can capture a browser source can put the live worldwide numbers on screen
for the entire protest — until it finishes.

## 1. Attach a live video to a protest

Create the live stream on the YouTube channel first, then attach its video id:

```bash
curl -X PATCH http://localhost:3000/api/protests/climate-clock \
  -H 'content-type: application/json' \
  -d '{"youtube": {"videoId": "2Mp0L4pUpzE", "live": true}}'
```

The protest page (`/protest.html?id=climate-clock`) now embeds the stream above the KPI panels.

## 2. Add the KPI overlay in OBS (or Streamlabs / vMix / XSplit)

1. Add a **Browser** source.
2. URL: `https://<your-host>/overlay.html?id=climate-clock`
3. Width `1920`, height `1080` (the layout is fluid and scales to any canvas).
4. Enable **transparent background** — the page has no background by default.
5. Refresh the browser source when the protest starts; it reconnects on its own afterwards.

Useful toggles inside the overlay (bottom-right, hidden from capture once toggled):

| Control | Effect |
| --- | --- |
| `toggle background` | Adds a solid background, useful for previewing outside OBS |
| `hide links` | Hides the small control links so they are never captured |

Appending `#solid` to the URL starts with the background on.

## 3. What the overlay shows

- The protest headline and a LIVE / opens-soon / finished badge
- Participants worldwide, split into verified vs injected test
- Countries and cities/areas count
- Joining per minute (last 5 minutes)
- Progress toward the worldwide target
- Top six countries, gender and age breakdown bars
- A live arrival ticker: generated protester name, city and country

Every number is pushed over Server-Sent Events the moment a join lands, from any country and over
any channel (internet, hotspot, Bluetooth, scanned code, or a synced offline queue).

## 4. Phone-friendly live dashboard

`/protest.html?id=...` is responsive: the same page works as a presenter screen, a phone view for
participants, and an embed inside another site (framing is explicitly allowed).

## 5. Number discipline

Injected test participants are counted separately in every payload (`real` vs `injected`) and are
labelled in the ticker. Before a real protest opens, clear them:

```bash
curl -X POST http://localhost:3000/api/test/inject/climate-clock/clear
```
