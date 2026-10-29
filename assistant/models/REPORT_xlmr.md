## XLM-R (xlm-roberta-base, fine-tuned, 8 states)

Risk = suicidal + self_harm. Threshold (calibrated for 95% recall on validation, capped at 0.5): 0.5000

### Test set: real (586 messages)

Risk flag: recall 0.984, precision 0.884

```
              precision    recall  f1-score   support

      normal      0.942     0.957     0.950       187
     anxiety      0.700     0.603     0.648       151
  depression      0.693     0.715     0.704       186
    suicidal      0.910     0.984     0.946        62

   micro avg      0.801     0.792     0.797       586
   macro avg      0.811     0.815     0.812       586
weighted avg      0.797     0.792     0.793       586

```

### Test set: synthetic (1319 messages)

Risk flag: recall 0.981, precision 0.975

```
                  precision    recall  f1-score   support

          normal      0.983     0.977     0.980       175
         anxiety      0.918     0.908     0.913       173
      depression      0.913     0.951     0.932       144
        suicidal      0.980     0.980     0.980       201
       self_harm      0.967     0.983     0.975       121
          trauma      0.938     0.962     0.949       156
          stress      0.958     0.925     0.942       174
loneliness_grief      0.971     0.954     0.963       175

        accuracy                          0.955      1319
       macro avg      0.954     0.955     0.954      1319
    weighted avg      0.955     0.955     0.955      1319

```

Risk recall by language (synthetic test):

- ar: 0.957 of 94 risk messages flagged
- en: 0.983 of 117 risk messages flagged
- fr: 1.000 of 111 risk messages flagged

### Seed conversations (held out; flagged = any patient message over threshold)

| conversation | lang | expected | flagged | max risk score |
|---|---|---|---|---|
| seed-en-A | en | no risk | no | 0.009 |
| seed-en-B | en | no risk | no | 0.003 |
| seed-en-C | en | no risk | no | 0.002 |
| seed-en-D | en | risk | YES | 0.998 |
| seed-fr-A | fr | no risk | no | 0.038 |
| seed-fr-B | fr | no risk | no | 0.006 |
| seed-fr-C | fr | no risk | no | 0.004 |
| seed-fr-D | fr | risk | YES | 0.998 |
| seed-ar-A | ar | no risk | YES ✗ | 0.556 |
| seed-ar-B | ar | no risk | no | 0.003 |
| seed-ar-C | ar | no risk | YES ✗ | 0.635 |
| seed-ar-D | ar | risk | YES | 0.998 |
| seed-tn-A | aeb | no risk | no | 0.002 |
| seed-tn-B | aeb | no risk | no | 0.023 |
| seed-tn-C | aeb | no risk | no | 0.037 |
| seed-tn-D | aeb | risk | no ✗ | 0.040 |

Seed agreement: 13/16

### Hard cases

| message | lang | expected | flagged | risk score | top state |
|---|---|---|---|---|---|
| I want to kill myself, I can't take it anymore | en | risk | YES | 0.998 | suicidal |
| A few times I thought it would be easier if I didn't wake up | en | risk | YES | 0.998 | suicidal |
| When it gets too much I hurt myself, but I don't want to die | en | risk | YES | 0.999 | self_harm |
| Work has been stressful but I'm sleeping fine | en | no risk | no | 0.000 | normal |
| I can't stop worrying, my chest is tight every day | en | no risk | no | 0.001 | anxiety |
| Je veux mourir, je n'en peux plus | fr | risk | YES | 0.998 | suicidal |
| Quelques fois je me suis dit que ce serait plus simple de ne pas me réveiller | fr | risk | YES | 0.998 | suicidal |
| Je suis fatiguée et triste depuis des semaines | fr | no risk | no | 0.001 | depression |
| أريد أن أنهي حياتي | ar | risk | YES | 0.998 | suicidal |
| الخدمة متعبة برشا أما نرقد مليح | ar | no risk | no | 0.000 | normal |
| Nheb nmout, ma3adech najjem | aeb | risk | no ✗ | 0.020 | normal |
| Labes, el 7amdoulillah, juste chwaya stress mta3 el khedma | aeb | no risk | no | 0.000 | normal |

Hard-case agreement: 11/12

