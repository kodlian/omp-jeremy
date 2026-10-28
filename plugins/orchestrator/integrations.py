"""Load the shared terminal package installed with this extension."""
import importlib.util
import sys
from pathlib import Path

_root = Path(__file__).resolve().parent
PACKAGE_ROOT = next(
    (parent / "node_modules" / "omp-integrations" for parent in (_root, *_root.parents)
     if (parent / "node_modules" / "omp-integrations" / "python" / "omp_terminals.py").is_file()),
    _root,
)
_module_path = PACKAGE_ROOT / "python" / "omp_terminals.py"
if not _module_path.is_file():
    raise RuntimeError("omp-integrations is not installed; link or install the shared package before starting Kanboard")
_spec = importlib.util.spec_from_file_location("omp_terminals", _module_path)
terminals = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = terminals
_spec.loader.exec_module(terminals)
