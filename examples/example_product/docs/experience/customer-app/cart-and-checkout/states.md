# States

## States

| State | When | What the user sees |
|---|---|---|
| Editing | Basket has items | Items, total, Pay button. |
| Paying | Pay tapped, waiting for the API | Spinner on the Pay button; basket locked. |
| Verifying | Payment needs 3-D Secure | The bank's page in a sheet. |
| Placed | Order placed | Confirmation with estimated delivery time. |
| Declined | Payment declined | Message and card picker; basket kept. |
| Closed | Restaurant closed during payment | Message; no charge; link back to restaurant list. |

## Transitions

| From | Event | To |
|---|---|---|
| Editing | tap Pay | Paying |
| Paying | placeOrder returns PLACED | Placed |
| Paying | placeOrder returns REQUIRES_ACTION | Verifying |
| Paying | placeOrder returns DECLINED | Declined |
| Paying | placeOrder returns RESTAURANT_CLOSED | Closed |
| Verifying | bank check completes | Placed |
| Declined | choose another card | Editing |
