"""Load the shared terminal package installed with this extension."""
import importlib.util
import sys
from pathlib import Path

PACKAGE_ROOT = Path(__file__).resolve().parent
_module_path = PACKAGE_ROOT / "python" / "omp_terminals.py"
if not _module_path.is_file():
    raise RuntimeError("Orchestrator's bundled terminal helper is missing; reinstall the plugin")
_spec = importlib.util.spec_from_file_location("omp_terminals", _module_path)
terminals = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = terminals
_spec.loader.exec_module(terminals)
