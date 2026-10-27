# Using Agent Monitor


Use the **Theme** selector in the top bar to choose **Green** (default), **Charcoal**, or **Light**. The choice is saved locally and restored on the next launch. Sidebar rows and section titles use text without decorative icons. Theme, provider, and run pickers use custom keyboard-accessible menus.

The range button next to **Recent runs** (**Last 24 h** by default) limits the sidebar and the run picker to runs whose activity overlaps that period. Click it for the presets **Today** (since local midnight), **Last 24 h** and **All**, which apply at once and are remembered across launches, or pick a custom range on the calendar: click a start day and an end day, adjust the **HH:MM** times, and leave **Now** on to keep the end at the current time. Arrow keys, **Page Up / Page Down** and **Enter** work in the calendar; **Reset** returns to the last 24 hours. A custom range lasts until the app restarts. The selected run always stays listed, and runs with a working agent stay listed too unless the custom range has a fixed end. Token counts are shown as **K / M / B** by default; choose **Full** under **Settings → General → Number format** (or with the toggle in the token breakdown) for exact digits. Hovering a compact count shows the exact value.

Use **Expand trace** or **Open trace in tab** in the details panel to read entries across the full window. Trace tabs use conversation cards with collapsible thinking and tool groups. Tool inputs and results are paired by their call IDs, including interleaved results; unmatched outputs remain visible. Search and event-kind filters keep matching conversation context together. Consecutive cumulative thinking summaries collapse into one block with an update count. Refresh reloads the recent entries, and the Graph tab returns to the canvas.

## Token usage and cost estimates

The sidebar shows combined input/output totals for loaded runs. Click the graph's token totals to open a per-agent breakdown, aggregated IN/OUT totals, a tokens-per-minute chart, and cumulative usage. Live counters use rolling digits and respect reduced-motion settings.

USD values use each model's official API list price, including available cache and context-tier metadata; missing details are assumed and noted. They are API-equivalent estimates, not subscription bills. Only models without a list price remain unpriced, and the breakdown discloses them. See [pricing sources and assumptions](token-pricing.md).
