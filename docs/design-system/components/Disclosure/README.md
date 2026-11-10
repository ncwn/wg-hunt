# Disclosure

Folds secondary information away until the seeker asks for it. It's the system's main tool for showing less.

- `title` names what's inside, in words ("Request log", "Advanced"). `hint` previews it in muted text while it's closed ("Last 30 days"), so people know whether to open it.
- It opens and closes itself, closed unless `defaultOpen`; `open` holds it open. The button carries `aria-expanded`; [States and motion](../../README.md#states-and-motion) has how a fold opens.
- `quiet` turns it into an inline sky link, such as a Search's "More options".
- Use it for anything that helps a few people sometimes: an offer's Facts, Settings › Advanced, the request log. Don't fold the four facts, the band or the main action.
