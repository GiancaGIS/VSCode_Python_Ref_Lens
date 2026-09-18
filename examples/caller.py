from demo import greet


# A reference to a function value, rather than a direct call.
greeting_callback = greet


def welcome() -> str:
    return greet("Another file")
