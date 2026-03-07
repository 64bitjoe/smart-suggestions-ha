"""Constants for Smart Suggestions."""

DOMAIN = "smart_suggestions"

CONF_OLLAMA_URL = "ollama_url"
CONF_OLLAMA_MODEL = "ollama_model"
CONF_WATCH_ENTITIES = "watch_entities"
CONF_AVAILABLE_ENTITIES = "available_entities"
CONF_AVAILABLE_AUTOMATIONS = "available_automations"
CONF_AVAILABLE_SCRIPTS = "available_scripts"
CONF_REFRESH_INTERVAL = "refresh_interval"
CONF_MAX_SUGGESTIONS = "max_suggestions"

DEFAULT_OLLAMA_URL = "http://localhost:11434"
DEFAULT_MODEL = "llama3.2"
DEFAULT_REFRESH_INTERVAL = 10
DEFAULT_MAX_SUGGESTIONS = 7
