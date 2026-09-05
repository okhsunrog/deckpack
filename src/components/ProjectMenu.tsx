import { open, save } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useState } from "react";
import { commands, type ProjectFile, type RecentProject } from "../bindings";
import { usePlannerStore } from "../store/planner-store";

const PROJECT_FILTER = [{ name: "Deckpack project", extensions: ["json"] }];

/** Open / save / save-as and the recent-projects list; Ctrl+O and Ctrl+S. */
export function ProjectMenu() {
  const projectPath = usePlannerStore((state) => state.projectPath);
  const setProjectPath = usePlannerStore((state) => state.setProjectPath);
  const loadProject = usePlannerStore((state) => state.loadProject);
  const [recent, setRecent] = useState<RecentProject[]>([]);

  const refreshRecent = useCallback(() => {
    commands
      .recentProjects()
      .then(setRecent)
      .catch((error: unknown) => console.error("Recent projects unavailable", error));
  }, []);

  useEffect(refreshRecent, [refreshRecent]);

  const openPath = useCallback(
    async (path: string) => {
      const result = await commands.loadProject(path);
      if (result.status === "error") {
        window.alert(`Не удалось открыть проект: ${result.error}`);
        void commands.forgetProject(path);
      } else if (!loadProject(result.data, path)) {
        window.alert("Файл проекта повреждён или ссылается на неизвестные данные.");
      }
      refreshRecent();
    },
    [loadProject, refreshRecent],
  );

  const openDialog = useCallback(async () => {
    const path = await open({ multiple: false, directory: false, filters: PROJECT_FILTER });
    if (path) await openPath(path);
  }, [openPath]);

  const saveTo = useCallback(
    async (path: string) => {
      const state = usePlannerStore.getState();
      const project: ProjectFile = {
        schemaVersion: 2,
        config: state.config,
        components: state.placements,
      };
      const result = await commands.saveProject(path, project);
      if (result.status === "error") {
        window.alert(`Не удалось сохранить проект: ${result.error}`);
        return;
      }
      setProjectPath(path);
      refreshRecent();
    },
    [refreshRecent, setProjectPath],
  );

  const saveAs = useCallback(async () => {
    const path = await save({
      defaultPath: projectPath ?? "deckpack-project.json",
      filters: PROJECT_FILTER,
    });
    if (path) await saveTo(path);
  }, [projectPath, saveTo]);

  const saveCurrent = useCallback(async () => {
    if (projectPath) await saveTo(projectPath);
    else await saveAs();
  }, [projectPath, saveAs, saveTo]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      const key = event.key.toLowerCase();
      if (key === "s") {
        event.preventDefault();
        void (event.shiftKey ? saveAs() : saveCurrent());
      } else if (key === "o") {
        event.preventDefault();
        void openDialog();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [openDialog, saveAs, saveCurrent]);

  return (
    <>
      <button type="button" title="Открыть проект (Ctrl+O)" onClick={() => void openDialog()}>
        Открыть
      </button>
      {recent.length > 0 && (
        <select
          className="recent-select"
          aria-label="Недавние проекты"
          value=""
          onChange={(event) => {
            const path = event.currentTarget.value;
            if (path) void openPath(path);
          }}
        >
          <option value="">Недавние…</option>
          {recent.map((entry) => (
            <option key={entry.path} value={entry.path} title={entry.path}>
              {entry.name}
            </option>
          ))}
        </select>
      )}
      <button type="button" title="Сохранить (Ctrl+S)" onClick={() => void saveCurrent()}>
        Сохранить
      </button>
      <button
        type="button"
        className="quiet-button"
        title="Сохранить как… (Ctrl+Shift+S)"
        onClick={() => void saveAs()}
      >
        Как…
      </button>
    </>
  );
}
