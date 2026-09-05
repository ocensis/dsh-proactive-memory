# Demo retail policy

A short stand-in for the domain policy a real run passes as `policyFile`. It is the memory model's
only source of rules: it may quote from here and nowhere else.

- Authenticate the user at the start of the conversation by locating their user id via email, or via
  first name + last name + zip code. That is the whole of authentication; there is no second factor.
- Once the user id is located, you may look up and discuss that user's own profile, orders and
  products. You may help exactly one user per conversation.
- Before any action that updates the database (cancel, modify, return, exchange), list the action
  details and obtain an explicit "yes" from the user.
- A delivered order can be returned or exchanged; a pending order can be cancelled or modified.
- Do not make up information, procedures or recommendations that neither the user nor a tool gave you.
