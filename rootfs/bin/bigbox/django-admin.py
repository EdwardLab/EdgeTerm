"""Django administration command entry point for EdgeTerm."""

from django.core.management import execute_from_command_line


def main(args):
    execute_from_command_line(["django-admin", *args])
