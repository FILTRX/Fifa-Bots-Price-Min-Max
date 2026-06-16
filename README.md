FIFA WC 2026 Resale Ticket Bot
A Chrome extension for automated FIFA World Cup 2026 resale ticket sniping.
Monitors FIFA resale seat maps in real time, intercepts live seat availability directly from the STX widget, finds the cheapest adjacent tickets matching your price range, and adds them to cart — all automatically.
Features

Intercepts STX seat data via OpenLayers zone canvas clicks + XHR hooking
Scans the cheapest zones first (sorted by minPrice) — stops as soon as a matching group is found
Finds the best adjacent seat group: greedy expansion up to maxSeats, prioritizing most seats then lowest total price
Price-only filtering — no category restriction, any seat under your max price qualifies
Human-like behavior: randomized delays (800–2500ms) and simulated mouse movement before each zone click to avoid DataDome detection
Floating control panel injected directly into FIFA pages
Popup configuration with persistent settings
Auto-resumes after page reloads
Stops automatically when cart page is reached

Supported Website
https://fwc26-resale-usd.tickets.fifa.com
Installation

Download or clone this repository
Open Chrome and navigate to chrome://extensions
Enable Developer Mode (top right toggle)
Click Load unpacked and select the extension folder
The FIFA Ticket Bot icon will appear in your toolbar

How to Use

Open a FIFA resale match page:

   https://fwc26-resale-usd.tickets.fifa.com/secure/selection/event/seat/performance/<PERFORMANCE_ID>/lang/en

Log into your FIFA account
Click the extension icon and configure:

Match ID — the performance ID from the URL
Min seats — minimum adjacent seats required (e.g. 2)
Max seats — greedy ceiling (e.g. 4 = take up to 4 if available together)
Min price / Max price — USD range (0 = no limit)
Interval — polling frequency in seconds


Press Start Bot and keep the tab open

The bot will automatically scan zones, find matching seats, select them, and click Add to cart.
How It Works
Two scripts are injected into FIFA pages:
interceptor.js — runs in the page's MAIN world at document_start, before DataDome loads. Hooks XMLHttpRequest to capture STX responses, intercepts the OpenLayers console.log('features', ...) call to extract zone data, and simulates realistic PointerEvent canvas clicks (pointerId: 1, pointerType: 'mouse') that OL's updateTrackedPointers_ accepts.
content.js — runs in the isolated extension world. Dispatches selectBlockByAvailabilities to load all zones, clicks the cheapest zones one by one, collects individual seat data from XHR responses, runs adjacent-group search, dispatches selectSeatsByIds, and clicks Add to cart.
Workflow
Page loads
    ↓
interceptor.js hooks XHR + console.log before DataDome
    ↓
Bot dispatches selectBlockByAvailabilities
    ↓
OL fires features[] → interceptor extracts zones (id, minPrice, flatCoords)
    ↓
Sort zones cheapest-first, scan top 5
    ↓
PointerEvent click on canvas centroid → STX fetches /seats/free/ol
    ↓
interceptor captures XHR response → posts seat data to content.js
    ↓
Filter by price → find cheapest N adjacent seats (same block + row)
    ↓
Dispatch selectSeatsByIds → STX selects seats on map
    ↓
Wait for Add to cart button → click
    ↓
Redirect to /cart/shoppingCart → bot stops
Important Notes

The tab must remain open and visible while the bot runs
You must be logged into your FIFA account before starting
Set Max price = 0 to disable the price ceiling
Zone minPrice values from OL are in 1/1000 USD (500000 = $500) — the bot handles conversion automatically
DataDome may temporarily block access if too many zones are clicked in quick succession — the bot limits scans to 5 zones per cycle with randomized delays
FIFA/STX may update their site structure at any time
