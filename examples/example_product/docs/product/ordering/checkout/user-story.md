# Checkout

## Story

As a customer, I want to pay for my basket in one step, so that my food is on its way without extra screens.

## Acceptance criteria

- Given a valid basket and a saved card, when I tap Pay, then the order is placed and I see the estimated delivery time.
- Given the restaurant closed while I was paying, when I tap Pay, then no money is taken and I am told the restaurant is closed.
- Given my bank asks for 3-D Secure, when I complete it, then the order is placed as if no check had been needed.
- Given the payment is declined, when I tap Pay, then the basket is kept and I can choose another card.

## Out of scope

- Splitting a bill between several people.
- Paying with cash.
