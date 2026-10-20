# Power Data Quality and Calibration

The power meter is the foundation of power-based training, but "having power numbers" does not mean "the power is trustworthy". Missing calibration, zero drift, imbalance, and temperature drift all cause systematic offsets. The most dangerous form looks stable and plausible while being uniformly high or low — it turns a dossier peak-power PB into a fictional baseline and makes a coach misdiagnose "calibration offset" as "fitness decline".

## Heuristics for detecting distortion

The more of these signs appear, the more likely the power is distorted:

1. **Broken power-HR relationship**: IF/NP clearly above comparable historical rides, but HR response and subjective notes do not support it. Power says "harder", the body says "no".
2. **Unexplained 20-min peak jump**: the dossier peak power (check with get_dossier) jumps >10% after one ride with no training stimulus to explain it, and is never reproduced afterwards.
3. **Systematic cross-device offset**: after swapping meters/bikes, same-intensity rides show a stable shift in average power (e.g. consistently +8%).
4. **w/kg contradicts climbing performance**: climbing w/kg implausible for the rider's power profile, or the reverse.
5. **User testimony**: the user says "the meter seems uncalibrated" or "values changed after I swapped the battery". This is the highest-weight evidence.

## Handling procedure

Choose by confidence in the distortion:

- **Highly suspect (multiple heuristics hit, or user confirms)**:
  1. First call `set_power_flag` (activity_id + flagged=true) to isolate the ride from the dossier's power baselines and state the reason — this stops distorted data from polluting peak-power PBs and intensity structure;
  2. Discuss with the user: any calibration records? Is the offset one-off or systematic?
- **A credible factor is available (user states the offset, or HR-power cross-validation yields a stable ratio)**:
  1. Call `recalibrate_activity_power` (activity_id + scale_factor = true/recorded, range 0.5–1.5) to rescale and write back all power-derived metrics of that ride;
  2. Relay the old-vs-new diff (NP/TSS/peak power returned by the tool) and note that the dossier updates automatically;
  3. Mention the revert path: re-import the original FIT file, or run the inverse factor.
- **Unsure**: prefer `set_power_flag` to isolate and observe — never rescale on a guess. Scaling is a corrective write; flagging is just isolation pending discussion.

## Boundaries and discipline

- The factor must come from data or the user, **never invented**; out-of-range factors are clamped to 0.5–1.5, and a clamped result is untrustworthy — flag instead.
- One calibration affects **one ride**; for a systematic multi-ride offset confirm rides individually (or suggest a full re-import) rather than guessing one factor for all.
- Flagging and calibration never touch HR, duration, or the raw per-second data — "power distorted" does not mean "the ride did not happen".
- FTP estimation/update (estimate_ftp/update_ftp) is flag-aware: flagged rides are automatically excluded from the estimation sample; estimate_ftp results and update_ftp rejections state the exclusion count in their data_needs list, and the auto-adopt freshness gate likewise ignores flagged samples. Do not discount or "correct" the estimate on the assumption that distorted data may have leaked in. Your discipline is down to two rules: when citing a specific suspect ride as evidence, avoid relying on its power, and relay the exclusion to the user (e.g. "the estimate excluded 2 flagged rides").
