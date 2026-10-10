# Data licence

The MIT licence in [LICENSE](LICENSE) covers the code. The data is licensed separately.

## `web/src/generated/` and `docs/` images

These files are derived from the **Fragrantica.com Fragrance Dataset** by olgagmiufana1 on Kaggle
(https://www.kaggle.com/datasets/olgagmiufana1/fragrantica-com-fragrance-dataset), licensed
**CC BY-NC-SA 4.0** (https://creativecommons.org/licenses/by-nc-sa/4.0/). The derived files are shared
under the same licence: credit the source, no commercial use, share alike.

Price fields in `catalog.json` additionally draw on:

- Sephora Products and Skincare Reviews by nadyinky on Kaggle, CC BY 4.0
  (https://www.kaggle.com/datasets/nadyinky/sephora-products-and-skincare-reviews)
- Perfume E-Commerce Dataset by muneebmuhammadali on Kaggle, ODC-By
  (https://www.kaggle.com/datasets/muneebmuhammadali/perfume-e-commerece-dataset)

This project is not affiliated with Fragrantica, Sephora or eBay. Raw downloads are not stored in the
repository; `pipeline/build.py` rebuilds everything from them.
