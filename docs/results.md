# RollWatch test results

All tests are done by holding the bare sensor board and flipping it by hand on a desk.
No doll, no onesie, no person. Not a medical device.

> Not measured yet. Do not change or round numbers in our favor.

Firmware: `fw=1`, 3 s wait before an alarm (Fast alert off) unless noted.
Board: ________  Date: ________

## 1. Flip detection

What we do: turn the board face down 20 times, waiting for "All good" in between.

| Flips | Alarms | Result |
|---|---|---|
| 20 | __ | __ / 20 |

## 2. False alerts

What we do: with the board face up, tilt it, shake it gently and lay it on its side 20 times, without turning it face down.

| Tries | Alarms (should be 0) |
|---|---|
| 20 | __ |

## 3. Alarm delay

What we do: 10 flips, stopwatch from the moment it is face down to the alarm.

| Try | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|
| Seconds | | | | | | | | | | |

Average: __ s  Max: __ s  Extra delay beyond the 3 s wait: __ s

## 4. Unplug

What we do: pull the USB cable 5 times and time how long until "No signal".

| Try | 1 | 2 | 3 | 4 | 5 |
|---|---|---|---|---|---|
| Seconds | | | | | |

Average: __ s  Max: __ s

## 5. Logic tests

`npm test`: __ passed / __ total

## 6. Early warning

What we do: 10 slow rolls through the side onto the face. Then 10 periods of the board lying still on its side.

| Slow rolls | Early warning came before the flip |
|---|---|
| 10 | __ / 10 |

| Still side periods | Early warnings (should be 0) |
|---|---|
| 10 | __ |

MOTION_T used: ____ (from still: ____ g, moving: ____ g)

## 7. Analytics tests

`npm test` (tests/analytics.test.js, hand-made night with known answers): __ passed / __ total

## 8. AI faithfulness

What we do: on one real night, 5 summaries and 5 questions. Check every number in each answer against the Night report.

| Answers | Answers with a wrong or invented number |
|---|---|
| 10 | __ |

Also ask 2 health questions. Did the AI refuse medical advice and point to a pediatrician? __ / 2

## Notes on bad tries

(Write down anything odd, e.g. "cable got pulled".)

## Limitations

- One board, flipped by hand. A body moves very differently.
- Wired USB only; the board is not sealed, washable or safe near a baby.
- Stopwatch timings include human reaction time.
- Only knows face down vs face up; it does not monitor breathing or prevent SIDS.
