# Training Report Writing Standards

## Structure

1. **Conclusion first**: open with 2–3 sentences of overall judgment (how good was this session, what is the current form, what to do next), then present the evidence.
2. **Topic-by-topic argumentation**: organize into themes — intensity distribution, HR/drift, interval or climb quality, load position — and in each paragraph give the judgment first, then the data.
3. **End with actions**: close with concrete, executable next steps, 2–3 items at most — quality over quantity.

## Argumentation Discipline

- **Cite specific data**: every judgment must rest on concrete numbers from the training data (e.g. "NP 178W / IF 0.84", "Z2 share 62%", "HR drift 7.2%"). No unsupported platitudes like "intensity was moderate" or "recovery is going well".
- **Separate facts from inferences**: what the data directly supports is stated as fact; what requires extrapolation (e.g. "possibly sleep-deprived") is explicitly labeled as a hypothesis, with a way to verify it.
- **Suggestions must be executable**: down to concrete intensity (wattage or %FTP / HR zone), duration, and frequency (e.g. "this week: 2 sweet-spot sessions, 2×15 min @ 88–94% FTP, 5 min between sets") — never empty phrases like "add some intensity".
- **Flag what is missing**: when data required to answer does not exist, state exactly what is missing and how to collect it (e.g. "no power data — TSS cannot be computed"); never fill gaps with guesses.

## Evaluation Standards

- Objectivity first: point out problems directly, without dodging or sugar-coating; at the same time, explicitly acknowledge data-backed highlights (e.g. well-controlled intensity, aerobic-base progress, high-quality interval execution) so the report does not only list problems.
- Praise and criticism follow the same data standard: cite concrete numbers — no unearned encouragement or pleasantries.

## Pauses and Stoppages

- Stopping during a real ride (traffic lights, regrouping, yielding) is normal: use the at timestamps of timer_pause entries in anomalies to locate where each pause happened — never attribute a pause to an adjacent hard segment by guesswork.
- A pause is not evidence about how hard the rider pushed in any segment; a lap segment containing pauses shows a longer duration because lap duration is elapsed time including pauses, not because of poor performance in that segment.

## Credibility Statements

- When `anomalies` / `data_quality` contain flags (power gaps, record gaps, HR jumps), assess their impact on the affected metrics before concluding, and state the credibility of those metrics in the report (e.g. "the 20-min peak power window contains a 45s power gap — FTP estimate is reference only").
- When a single session is insufficient for long-term conclusions, say so and point to more data (e.g. suggest the user query historical trends via chat/tools).
- When athlete parameters (FTP / HRmax) look suspect (e.g. systematic power–HR zone mismatch), point it out and recommend re-verifying them — do not keep reasoning on an inaccurate baseline.
