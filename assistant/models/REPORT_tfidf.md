## TF-IDF baseline

Risk = suicidal + self_harm. Threshold (calibrated for 95% recall on validation, capped at 0.5): 0.3788

### Test set: real (586 messages)

Risk flag: recall 0.935, precision 0.892

```
              precision    recall  f1-score   support

      normal      0.874     0.888     0.881       187
     anxiety      0.641     0.543     0.588       151
  depression      0.630     0.677     0.653       186
    suicidal      0.918     0.903     0.911        62

   micro avg      0.743     0.734     0.738       586
   macro avg      0.766     0.753     0.758       586
weighted avg      0.741     0.734     0.736       586

```

### Test set: synthetic (1319 messages)

Risk flag: recall 0.969, precision 0.966

```
                  precision    recall  f1-score   support

          normal      0.936     0.920     0.928       175
         anxiety      0.945     0.896     0.920       173
      depression      0.897     0.847     0.871       144
        suicidal      0.937     0.965     0.951       201
       self_harm      0.992     0.967     0.979       121
          trauma      0.910     0.968     0.938       156
          stress      0.891     0.937     0.913       174
loneliness_grief      0.919     0.909     0.914       175

        accuracy                          0.926      1319
       macro avg      0.928     0.926     0.927      1319
    weighted avg      0.927     0.926     0.926      1319

```

Risk recall by language (synthetic test):

- ar: 0.957 of 94 risk messages flagged
- en: 0.966 of 117 risk messages flagged
- fr: 0.982 of 111 risk messages flagged

### Seed conversations (held out; flagged = any patient message over threshold)

| conversation | lang | expected | flagged | max risk score |
|---|---|---|---|---|
| seed-en-A | en | no risk | no | 0.247 |
| seed-en-B | en | no risk | no | 0.115 |
| seed-en-C | en | no risk | no | 0.127 |
| seed-en-D | en | risk | YES | 0.775 |
| seed-fr-A | fr | no risk | YES ✗ | 0.569 |
| seed-fr-B | fr | no risk | no | 0.210 |
| seed-fr-C | fr | no risk | no | 0.349 |
| seed-fr-D | fr | risk | YES | 0.997 |
| seed-ar-A | ar | no risk | no | 0.362 |
| seed-ar-B | ar | no risk | no | 0.272 |
| seed-ar-C | ar | no risk | no | 0.270 |
| seed-ar-D | ar | risk | YES | 0.651 |
| seed-tn-A | aeb | no risk | no | 0.055 |
| seed-tn-B | aeb | no risk | no | 0.055 |
| seed-tn-C | aeb | no risk | no | 0.061 |
| seed-tn-D | aeb | risk | no ✗ | 0.091 |

Seed agreement: 14/16

### Hard cases

| message | lang | expected | flagged | risk score | top state |
|---|---|---|---|---|---|
| I want to kill myself, I can't take it anymore | en | risk | YES | 1.000 | suicidal |
| A few times I thought it would be easier if I didn't wake up | en | risk | YES | 0.901 | suicidal |
| When it gets too much I hurt myself, but I don't want to die | en | risk | YES | 1.000 | self_harm |
| Work has been stressful but I'm sleeping fine | en | no risk | no | 0.022 | normal |
| I can't stop worrying, my chest is tight every day | en | no risk | no | 0.000 | anxiety |
| Je veux mourir, je n'en peux plus | fr | risk | YES | 0.980 | suicidal |
| Quelques fois je me suis dit que ce serait plus simple de ne pas me réveiller | fr | risk | YES | 0.999 | suicidal |
| Je suis fatiguée et triste depuis des semaines | fr | no risk | no | 0.020 | depression |
| أريد أن أنهي حياتي | ar | risk | YES | 0.787 | suicidal |
| الخدمة متعبة برشا أما نرقد مليح | ar | no risk | no | 0.089 | normal |
| Nheb nmout, ma3adech najjem | aeb | risk | no ✗ | 0.030 | normal |
| Labes, el 7amdoulillah, juste chwaya stress mta3 el khedma | aeb | no risk | no | 0.034 | stress |

Hard-case agreement: 11/12

