"""Code sandbox: runs untrusted tool code in throwaway containers (a separate process).

Only this process talks to Docker, through a filtering socket proxy. The API and the worker
never execute tool code: they call this service over HTTP with a shared token.
"""
