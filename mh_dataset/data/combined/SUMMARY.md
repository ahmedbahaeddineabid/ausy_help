# Combined dataset summary

Labelled rows: 5875  |  all rows (incl. aux): 83115

- train: 4703
- validation: 586
- test: 586

## mental_state

- depression: 1867
- normal: 1867
- anxiety: 1520
- suicidal: 621

## source

- reddit: 3996
- goemotions: 932
- emotion: 931
- seed: 16

## label_quality

- weak: 5859
- gold: 16

## language

- en: 5863
- fr: 4
- ar: 4
- aeb: 4

## mental_state by source

```
mental_state  anxiety  depression  normal  suicidal
source                                             
emotion             0           0     931         0
goemotions          0           0     932         0
reddit           1516        1863       0       617
seed                4           4       4         4
```

## Shortcut check

style-only macro-F1 0.30 (chance about 0.25) -> OK
