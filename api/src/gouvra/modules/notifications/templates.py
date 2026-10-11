"""Transactional e-mail templates (English and French), rendered as HTML + plain text.

Every user-provided value is HTML-escaped. Links carry one-time tokens in the URL fragment.
"""

from __future__ import annotations

from dataclasses import dataclass
from html import escape
from typing import Any

BRAND = "#2563EB"
INK = "#172B4D"
MUTED = "#5B6880"


@dataclass(frozen=True)
class RenderedEmail:
    subject: str
    html: str
    text: str


@dataclass(frozen=True)
class _Copy:
    subject: str
    title: str
    paragraphs: tuple[str, ...]
    button: str | None = None
    footnote: str | None = None


_COPY: dict[str, dict[str, _Copy]] = {
    "verify_email": {
        "en": _Copy(
            "Confirm your e-mail address",
            "Confirm your e-mail address",
            (
                "Hi {name},",
                "Welcome to Gouvra. Confirm that {email} is your address to finish creating "
                "your account.",
            ),
            "Confirm my address",
            "This link expires in 24 hours. If you did not create an account, ignore this e-mail.",
        ),
        "fr": _Copy(
            "Confirmez votre adresse e-mail",
            "Confirmez votre adresse e-mail",
            (
                "Bonjour {name},",
                "Bienvenue sur Gouvra. Confirmez que {email} est bien votre adresse pour "
                "terminer la création de votre compte.",
            ),
            "Confirmer mon adresse",
            "Ce lien expire dans 24 heures. Si vous n'avez pas créé de compte, ignorez cet e-mail.",
        ),
    },
    "account_exists": {
        "en": _Copy(
            "Someone tried to sign up with your address",
            "You already have a Gouvra account",
            (
                "Someone (probably you) tried to create a Gouvra account with {email}, "
                "which already has one.",
                "If it was you, sign in instead — or reset your password if you forgot it.",
            ),
            "Sign in",
            "If it wasn't you, you can ignore this e-mail: nothing has changed on your account.",
        ),
        "fr": _Copy(
            "Tentative d'inscription avec votre adresse",
            "Vous avez déjà un compte Gouvra",
            (
                "Quelqu'un (sans doute vous) a essayé de créer un compte Gouvra avec {email}, "
                "qui en possède déjà un.",
                "Si c'était vous, connectez-vous — ou réinitialisez votre mot de passe si vous "
                "l'avez oublié.",
            ),
            "Se connecter",
            "Si ce n'était pas vous, ignorez cet e-mail : rien n'a changé sur votre compte.",
        ),
    },
    "reset_password": {
        "en": _Copy(
            "Reset your Gouvra password",
            "Reset your password",
            ("Hi {name},", "We received a request to reset the password of {email}."),
            "Choose a new password",
            "This link expires in 1 hour and works once. If you did not ask for it, ignore this "
            "e-mail: your password stays the same.",
        ),
        "fr": _Copy(
            "Réinitialisez votre mot de passe Gouvra",
            "Réinitialisez votre mot de passe",
            ("Bonjour {name},", "Nous avons reçu une demande de réinitialisation pour {email}."),
            "Choisir un nouveau mot de passe",
            "Ce lien expire dans 1 heure et ne fonctionne qu'une fois. Si vous n'êtes pas à "
            "l'origine de la demande, ignorez cet e-mail : votre mot de passe ne change pas.",
        ),
    },
    "password_changed": {
        "en": _Copy(
            "Your Gouvra password was changed",
            "Your password was changed",
            (
                "Hi {name},",
                "The password of {email} was changed on {when}. Your other sessions were "
                "signed out.",
            ),
            None,
            "If you did not do this, reset your password right away and contact your "
            "workspace administrator.",
        ),
        "fr": _Copy(
            "Votre mot de passe Gouvra a été modifié",
            "Votre mot de passe a été modifié",
            (
                "Bonjour {name},",
                "Le mot de passe de {email} a été modifié le {when}. Vos autres sessions ont "
                "été déconnectées.",
            ),
            None,
            "Si vous n'êtes pas à l'origine de ce changement, réinitialisez votre mot de passe "
            "immédiatement et prévenez l'administrateur de votre workspace.",
        ),
    },
    "invitation": {
        "en": _Copy(
            "{inviter} invited you to {workspace} on Gouvra",
            "Join {workspace} on Gouvra",
            (
                "{inviter} invited you to join the workspace {workspace} as {role}.",
                "Gouvra is the control room where your team builds, runs and supervises AI agents.",
            ),
            "Accept the invitation",
            "This invitation is for {email} and expires on {expires}.",
        ),
        "fr": _Copy(
            "{inviter} vous invite dans {workspace} sur Gouvra",
            "Rejoignez {workspace} sur Gouvra",
            (
                "{inviter} vous invite à rejoindre le workspace {workspace} en tant que {role}.",
                "Gouvra est la salle de contrôle où votre équipe construit, exécute et "
                "supervise ses agents IA.",
            ),
            "Accepter l'invitation",
            "Cette invitation est destinée à {email} et expire le {expires}.",
        ),
    },
    "change_email": {
        "en": _Copy(
            "Confirm your new e-mail address",
            "Confirm your new address",
            ("Hi {name},", "Confirm that {email} should become the address of your account."),
            "Confirm this address",
            "This link expires in 24 hours. Your current address stays active until you confirm.",
        ),
        "fr": _Copy(
            "Confirmez votre nouvelle adresse e-mail",
            "Confirmez votre nouvelle adresse",
            (
                "Bonjour {name},",
                "Confirmez que {email} doit devenir l'adresse de votre compte.",
            ),
            "Confirmer cette adresse",
            "Ce lien expire dans 24 heures. Votre adresse actuelle reste active d'ici là.",
        ),
    },
    "email_changed_notice": {
        "en": _Copy(
            "The e-mail address of your Gouvra account changed",
            "Your sign-in address changed",
            (
                "Hi {name},",
                "Your Gouvra account now signs in with {email} instead of this address.",
            ),
            None,
            "If you did not do this, contact your workspace administrator right away.",
        ),
        "fr": _Copy(
            "L'adresse e-mail de votre compte Gouvra a changé",
            "Votre adresse de connexion a changé",
            (
                "Bonjour {name},",
                "Votre compte Gouvra se connecte désormais avec {email} au lieu de cette adresse.",
            ),
            None,
            "Si vous n'êtes pas à l'origine de ce changement, prévenez immédiatement "
            "l'administrateur de votre workspace.",
        ),
    },
    "alert": {
        "en": _Copy(
            "[Gouvra] {title}",
            "{title}",
            ("{body}",),
            "Open Gouvra",
            "You receive this alert as an administrator of {workspace}.",
        ),
        "fr": _Copy(
            "[Gouvra] {title}",
            "{title}",
            ("{body}",),
            "Ouvrir Gouvra",
            "Vous recevez cette alerte en tant qu'administrateur de {workspace}.",
        ),
    },
}

ROLE_NAMES = {
    "en": {"owner": "owner", "admin": "admin", "member": "member", "viewer": "viewer"},
    "fr": {
        "owner": "propriétaire",
        "admin": "administrateur",
        "member": "membre",
        "viewer": "lecteur",
    },
}

TEMPLATES = frozenset(_COPY)


def _fmt(text: str, values: dict[str, str]) -> str:
    return text.format(**values)


def render(
    template: str, locale: str, context: dict[str, Any], action_url: str | None
) -> RenderedEmail:
    """Render a template. `context` values are escaped for HTML; the action URL is attribute-safe."""
    lang = locale if locale in ("en", "fr") else "en"
    copy = _COPY[template][lang]
    raw = {k: str(v) for k, v in context.items()}
    if "role" in raw:
        raw["role"] = ROLE_NAMES[lang].get(raw["role"], raw["role"])
    safe = {k: escape(v) for k, v in raw.items()}

    subject = _fmt(copy.subject, raw)
    title_html = _fmt(copy.title, safe)
    paragraphs_html = "".join(
        f'<p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:{INK}">{_fmt(p, safe)}</p>'
        for p in copy.paragraphs
    )
    button_html = ""
    if copy.button and action_url:
        url = escape(action_url, quote=True)
        button_html = (
            '<table role="presentation" cellspacing="0" cellpadding="0" style="margin:22px 0">'
            f'<tr><td style="border-radius:6px;background:{BRAND}">'
            f'<a href="{url}" style="display:inline-block;padding:11px 20px;font-size:15px;'
            f'font-weight:600;color:#ffffff;text-decoration:none;border-radius:6px">'
            f"{escape(copy.button)}</a></td></tr></table>"
            f'<p style="margin:0 0 14px;font-size:13px;line-height:1.5;color:{MUTED}">'
            f"{'Or paste this link in your browser:' if lang == 'en' else 'Ou collez ce lien dans votre navigateur :'}"
            f'<br><a href="{url}" style="color:{BRAND};word-break:break-all">{url}</a></p>'
        )
    footnote_html = (
        f'<p style="margin:18px 0 0;font-size:13px;line-height:1.5;color:{MUTED}">'
        f"{_fmt(copy.footnote, safe)}</p>"
        if copy.footnote
        else ""
    )
    html = f"""<!doctype html>
<html lang="{lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>{escape(subject)}</title></head>
<body style="margin:0;padding:0;background:#F6F8FB;font-family:Inter,Segoe UI,Helvetica,Arial,sans-serif">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#F6F8FB;padding:32px 12px">
<tr><td align="center">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:540px">
<tr><td style="padding:0 4px 18px">
<span style="display:inline-block;width:22px;height:22px;border-radius:6px;background:{BRAND};vertical-align:middle"></span>
<span style="font-size:17px;font-weight:600;color:{INK};vertical-align:middle;margin-left:8px;letter-spacing:-0.02em">gouvra</span>
</td></tr>
<tr><td style="background:#ffffff;border:1px solid #D9E1EC;border-radius:10px;padding:28px">
<h1 style="margin:0 0 18px;font-size:20px;line-height:1.3;color:{INK}">{title_html}</h1>
{paragraphs_html}{button_html}{footnote_html}
</td></tr>
<tr><td style="padding:16px 4px;font-size:12px;color:{MUTED}">Gouvra · open-source control room for AI agents</td></tr>
</table></td></tr></table></body></html>"""

    text_lines = [_fmt(copy.title, raw), ""]
    text_lines += [_fmt(p, raw) for p in copy.paragraphs]
    if copy.button and action_url:
        text_lines += ["", f"{copy.button}: {action_url}"]
    if copy.footnote:
        text_lines += ["", _fmt(copy.footnote, raw)]
    text_lines += ["", "— Gouvra"]
    return RenderedEmail(subject=subject, html=html, text="\n".join(text_lines))
