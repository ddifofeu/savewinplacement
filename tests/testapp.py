#!/usr/bin/env python3
"""A window for the end-to-end test. Its app id is argv[1]; titles count up per app."""
import os
import sys

import gi
gi.require_version("Gtk", "4.0")
from gi.repository import Gio, Gtk

app_id = sys.argv[1]
counter_file = os.environ["TESTAPP_COUNTER"] + "." + app_id


def next_title():
    """Copies launched together must not share a number, so each claims one by creating a file."""
    count = 0
    while True:
        try:
            os.close(os.open(f"{counter_file}.{count}", os.O_CREAT | os.O_EXCL | os.O_WRONLY))
            return f"{app_id} window {count}"
        except FileExistsError:
            count += 1


def activate(app):
    window = Gtk.ApplicationWindow(application=app, title=next_title())
    window.set_default_size(420, 300)
    window.present()


app = Gtk.Application(application_id=app_id, flags=Gio.ApplicationFlags.NON_UNIQUE)
app.connect("activate", activate)
app.run([])
