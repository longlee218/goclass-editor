import "./index.scss";

import {
  API_ASSIGN_WORK_FINISH,
  API_LOAD_HINTS,
  APP_NAME,
  CLIENT_STUDENT,
  COOKIES,
  EVENT,
  SOCKET_URL,
  TITLE_TIMEOUT,
  VERSION_TIMEOUT,
} from "../constants";
import {
  AppState,
  BinaryFiles,
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState,
  LibraryItems,
} from "../types";
import Collab, {
  CollabAPI,
  collabAPIAtom,
  collabDialogShownAtom,
  isCollaboratingAtom,
} from "./collab/Collab";
import { Excalidraw, defaultLang } from "../packages/excalidraw/index";
import {
  ExcalidrawElement,
  FileId,
  NonDeletedExcalidrawElement,
} from "../element/types";
import {
  FIREBASE_STORAGE_PREFIXES,
  STORAGE_KEYS,
  SYNC_BROWSER_TABS_TIMEOUT,
} from "./app_constants";
import {
  MouseEventHandler,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Provider, useAtom } from "jotai";
import {
  ResolvablePromise,
  debounce,
  getFrame,
  getVersion,
  isTestEnv,
  preventUnload,
  resolvablePromise,
} from "../utils";
import { RestoredDataState, restore, restoreAppState } from "../data/restore";
import {
  exportToBackend,
  getCollaborationLinkData,
  isCollaborationLink,
  loadScene,
} from "./data";
import {
  getLibraryItemsFromStorage,
  importFromLocalStorage,
  importUsernameFromLocalStorage,
} from "./data/localStorage";
import { jotaiStore, useAtomWithInitialValue } from "../jotai";
import { parseLibraryTokensFromUrl, useHandleLibrary } from "../data/library";

import CustomStats from "./CustomStats";
import { ErrorDialog } from "../components/ErrorDialog";
import { ExportToExcalidrawPlus } from "./components/ExportToExcalidrawPlus";
import LanguageDetector from "i18next-browser-languagedetector";
import { LocalData } from "./data/LocalData";
import { TopErrorBoundary } from "../components/TopErrorBoundary";
import axios from "axios";
import clsx from "clsx";
import { getDefaultAppState } from "../appState";
import { isBrowserStorageStateNewer } from "./data/tabSync";
import { isInitializedImageElement } from "../element/typeChecks";
import { loadFilesFromFirebase } from "./data/firebase";
import { loadFromBlob } from "../data/blob";
import { newElementWith } from "../element/mutateElement";
import polyfill from "../polyfill";
import { reconcileElements } from "./collab/reconciliation";
import io from "socket.io-client";
import { t } from "../i18n";
import { trackEvent } from "../analytics";
import { updateStaleImageStatuses } from "./data/FileManager";
import { useCallbackRefState } from "../hooks/useCallbackRefState";

polyfill();
window.EXCALIDRAW_THROTTLE_RENDER = true;

const mainBackendSocket = io(SOCKET_URL, {
  path: "/socket",
});

interface IHint {
  _id: string;
  numSlide: number;
  isSupport: boolean;
  name: string;
  desc?: string;
  prevUrl?: string | null;
  nextUrl?: string | null;
  points?: number;
}

const isExcalidrawPlusSignedUser = document.cookie.includes(
  COOKIES.AUTH_STATE_COOKIE,
);

const languageDetector = new LanguageDetector();
languageDetector.init({
  languageUtils: {},
});

const initializeScene = async (opts: {
  collabAPI: CollabAPI;
  excalidrawAPI: ExcalidrawImperativeAPI;
}): Promise<
  { scene: ExcalidrawInitialDataState | null } & (
    | { isExternalScene: true; id: string; key: string }
    | { isExternalScene: false; id?: null; key?: null }
  )
> => {
  const searchParams = new URLSearchParams(window.location.search);
  const id = searchParams.get("id");
  const jsonBackendMatch = window.location.hash.match(
    /^#json=([a-zA-Z0-9_-]+),([a-zA-Z0-9_-]+)$/,
  );
  const externalUrlMatch = window.location.hash.match(/^#url=(.*)$/);

  const localDataState = importFromLocalStorage();

  let scene: RestoredDataState & {
    scrollToContent?: boolean;
  } = await loadScene(null, null, localDataState);

  let roomLinkData = getCollaborationLinkData(window.location.href);
  const isExternalScene = !!(id || jsonBackendMatch || roomLinkData);
  if (isExternalScene) {
    if (
      // don't prompt if scene is empty
      !scene.elements.length ||
      // don't prompt for collab scenes because we don't override local storage
      roomLinkData ||
      // otherwise, prompt whether user wants to override current scene
      window.confirm(t("alerts.loadSceneOverridePrompt"))
    ) {
      if (jsonBackendMatch) {
        scene = await loadScene(
          jsonBackendMatch[1],
          jsonBackendMatch[2],
          localDataState,
        );
      }
      scene.scrollToContent = true;
      if (!roomLinkData) {
        window.history.replaceState({}, APP_NAME, window.location.origin);
      }
    } else {
      // https://github.com/excalidraw/excalidraw/issues/1919
      if (document.hidden) {
        return new Promise((resolve, reject) => {
          window.addEventListener(
            "focus",
            () => initializeScene(opts).then(resolve).catch(reject),
            {
              once: true,
            },
          );
        });
      }

      roomLinkData = null;
      window.history.replaceState({}, APP_NAME, window.location.origin);
    }
  } else if (externalUrlMatch) {
    window.history.replaceState({}, APP_NAME, window.location.origin);

    const url = externalUrlMatch[1];
    try {
      const request = await fetch(window.decodeURIComponent(url));
      const data = await loadFromBlob(await request.blob(), null, null);
      if (
        !scene.elements.length ||
        window.confirm(t("alerts.loadSceneOverridePrompt"))
      ) {
        return { scene: data, isExternalScene };
      }
    } catch (error: any) {
      return {
        scene: {
          appState: {
            errorMessage: t("alerts.invalidSceneUrl"),
          },
        },
        isExternalScene,
      };
    }
  }

  if (roomLinkData) {
    const { excalidrawAPI } = opts;

    const scene = await opts.collabAPI.startCollaboration(roomLinkData);

    return {
      // when collaborating, the state may have already been updated at this
      // point (we may have received updates from other clients), so reconcile
      // elements and appState with existing state
      scene: {
        ...scene,
        appState: {
          ...restoreAppState(scene?.appState, excalidrawAPI.getAppState()),
          // necessary if we're invoking from a hashchange handler which doesn't
          // go through App.initializeScene() that resets this flag
          isLoading: false,
        },
        elements: reconcileElements(
          scene?.elements || [],
          excalidrawAPI.getSceneElementsIncludingDeleted(),
          excalidrawAPI.getAppState(),
        ),
      },
      isExternalScene: true,
      id: roomLinkData.roomId,
      key: roomLinkData.roomKey,
    };
  } else if (scene) {
    return isExternalScene && jsonBackendMatch
      ? {
          scene,
          isExternalScene,
          id: jsonBackendMatch[1],
          key: jsonBackendMatch[2],
        }
      : { scene, isExternalScene: false };
  }
  return { scene: null, isExternalScene: false };
};

const NavigateAssignmentJSX = ({
  hints,
  onClickRaiseHand,
  onClickSubmit,
}: {
  hints: IHint | null;
  onClickSubmit: MouseEventHandler<any>;
  onClickRaiseHand: MouseEventHandler<any>;
}): any => {
  const navigate = (e: any, url: string) => {
    e.preventDefault();
    window.location.href = url;
    window.location.reload();
  };
  return (
    <>
      {hints && (
        <div
          style={{
            width: isExcalidrawPlusSignedUser ? "21ch" : "48ch",
            fontSize: "0.7em",
            borderRadius: 4,
            background: "#fff",
            border: "1px solid #0f1e94",
          }}
        >
          <div
            style={{
              margin: "1rem 8px 0.4rem 8px",
              display: "flex",
              justifyContent: "space-between",
            }}
          >
            <p
              style={{
                color: "#0f1e94",
                fontSize: "2em",
                fontWeight: "bold",
                margin: 0,
              }}
            >
              C??u {hints.numSlide}
            </p>
            {typeof hints.points !== undefined && (
              <p
                style={{
                  color: "#f73481",
                  fontWeight: "bold",
                  fontSize: "1.5em",
                  margin: 0,
                }}
              >
                {hints.points} ??i???m
              </p>
            )}
          </div>
          <div
            style={{
              fontSize: "14px",
              margin: "0 8px 1rem 8px",
              lineHeight: 1.5,
            }}
          >
            <p>{hints.name}</p>
            {hints?.desc && (
              <i>
                <b>G???i ??:</b> {hints.desc}
              </i>
            )}
          </div>
          <div
            style={{ display: "flex", justifyContent: "space-between", gap: 8 }}
          >
            {hints.prevUrl && (
              <a
                href="#"
                className="plus-button"
                style={{ fontSize: "0.8rem", flex: 1 }}
                onClick={(e) => navigate(e, hints.prevUrl as string)}
              >
                Quay l???i
              </a>
            )}
            {hints.nextUrl && (
              <a
                href="#"
                rel="noreferrer"
                className="plus-button"
                style={{ fontSize: "0.8rem", flex: 1 }}
                onClick={(e) => navigate(e, hints.nextUrl as string)}
              >
                Ti???p theo
              </a>
            )}
          </div>
          <a
            href="#"
            rel="noreferrer"
            className="plus-button"
            style={{ fontSize: "0.8rem", flex: 1 }}
            onClick={onClickSubmit}
          >
            N???p b??i
          </a>
          {hints.isSupport && (
            <a
              href="#"
              className="plus-button--danger"
              style={{ fontSize: "0.8rem", flex: 1 }}
              onClick={onClickRaiseHand}
            >
              Tr??? gi??p
            </a>
          )}
        </div>
      )}
    </>
  );
};
// const NavigateAssignmentJSX = () => {
//   return (
//     <ul className="excalidraw-navigate">
//       <li className="excalidraw-item">1</li>
//     </ul>
//   );
// };

const ExcalidrawWrapper = () => {
  const [errorMessage, setErrorMessage] = useState("");
  let currentLangCode = languageDetector.detect() || defaultLang.code;
  if (Array.isArray(currentLangCode)) {
    currentLangCode = currentLangCode[0];
  }
  const [hints, setHints] = useState<IHint | null>(null);
  const [langCode, setLangCode] = useState(currentLangCode);

  const onClickSubmit = useCallback(
    (e: React.MouseEvent<HTMLAnchorElement, MouseEvent>) => {
      e.preventDefault();
      const roomLinkData = getCollaborationLinkData(window.location.href);
      if (roomLinkData) {
        const { sessionId, userId } = roomLinkData;
        if (window.confirm(t("alerts.submitAssignment"))) {
          axios({
            method: "POST",
            url: API_ASSIGN_WORK_FINISH,
            data: {
              assignWorkId: sessionId,
              userId,
            },
          })
            .then(({ data }) => {
              window.location.href = CLIENT_STUDENT;
            })
            .catch((error) => {
              window.location.href = CLIENT_STUDENT;
            });
        }
      }
    },
    [window.location.href],
  );

  const onClickRaiseHand = useCallback(
    (e: React.MouseEvent<HTMLAnchorElement, MouseEvent>) => {
      e.preventDefault();
      const roomLinkData = getCollaborationLinkData(window.location.href);
      if (roomLinkData) {
        const { roomId, userId, sessionId } = roomLinkData;
        mainBackendSocket.emit("raiseHand", sessionId, roomId, userId);
      }
    },
    [window.location.href],
  );

  useEffect(() => {
    mainBackendSocket.on("connect", () => {
      console.log("Socket connect");
    });
    mainBackendSocket.on("disconnect", () => {});
    return () => {
      mainBackendSocket.off("disconnect");
      mainBackendSocket.off("connect");
    };
  }, []);

  useEffect(() => {
    const roomLinkData = getCollaborationLinkData(window.location.href);
    if (roomLinkData) {
      const { roomId, sessionId, userId } = roomLinkData;
      axios({
        method: "GET",
        url: API_LOAD_HINTS,
        params: {
          userId,
          assignWorkId: sessionId,
          slideId: roomId,
        },
      }).then(({ data }) => {
        setHints(data.data);
      });
    }
  }, []);
  // initial state
  // ---------------------------------------------------------------------------

  const initialStatePromiseRef = useRef<{
    promise: ResolvablePromise<ExcalidrawInitialDataState | null>;
  }>({ promise: null! });
  if (!initialStatePromiseRef.current.promise) {
    initialStatePromiseRef.current.promise =
      resolvablePromise<ExcalidrawInitialDataState | null>();
  }

  useEffect(() => {
    trackEvent("load", "frame", getFrame());
    // Delayed so that the app has a time to load the latest SW
    setTimeout(() => {
      trackEvent("load", "version", getVersion());
    }, VERSION_TIMEOUT);
  }, []);

  const [excalidrawAPI, excalidrawRefCallback] =
    useCallbackRefState<ExcalidrawImperativeAPI>();

  const [collabAPI] = useAtom(collabAPIAtom);
  const [, setCollabDialogShown] = useAtom(collabDialogShownAtom);
  const [isCollaborating] = useAtomWithInitialValue(isCollaboratingAtom, () => {
    return isCollaborationLink(window.location.href);
  });

  useHandleLibrary({
    excalidrawAPI,
    getInitialLibraryItems: getLibraryItemsFromStorage,
  });

  useEffect(() => {
    if (!collabAPI || !excalidrawAPI) {
      return;
    }

    const loadImages = (
      data: ResolutionType<typeof initializeScene>,
      isInitialLoad = false,
    ) => {
      if (!data.scene) {
        return;
      }
      if (collabAPI.isCollaborating()) {
        if (data.scene.elements) {
          collabAPI
            .fetchImageFilesFromFirebase({
              elements: data.scene.elements,
            })
            .then(({ loadedFiles, erroredFiles }) => {
              excalidrawAPI.addFiles(loadedFiles);
              updateStaleImageStatuses({
                excalidrawAPI,
                erroredFiles,
                elements: excalidrawAPI.getSceneElementsIncludingDeleted(),
              });
            });
        }
      } else {
        const fileIds =
          data.scene.elements?.reduce((acc, element) => {
            if (isInitializedImageElement(element)) {
              return acc.concat(element.fileId);
            }
            return acc;
          }, [] as FileId[]) || [];

        if (data.isExternalScene) {
          loadFilesFromFirebase(
            `${FIREBASE_STORAGE_PREFIXES.shareLinkFiles}/${data.id}`,
            data.key,
            fileIds,
          ).then(({ loadedFiles, erroredFiles }) => {
            excalidrawAPI.addFiles(loadedFiles);
            updateStaleImageStatuses({
              excalidrawAPI,
              erroredFiles,
              elements: excalidrawAPI.getSceneElementsIncludingDeleted(),
            });
          });
        } else if (isInitialLoad) {
          if (fileIds.length) {
            LocalData.fileStorage
              .getFiles(fileIds)
              .then(({ loadedFiles, erroredFiles }) => {
                if (loadedFiles.length) {
                  excalidrawAPI.addFiles(loadedFiles);
                }
                updateStaleImageStatuses({
                  excalidrawAPI,
                  erroredFiles,
                  elements: excalidrawAPI.getSceneElementsIncludingDeleted(),
                });
              });
          }
          // on fresh load, clear unused files from IDB (from previous
          // session)
          LocalData.fileStorage.clearObsoleteFiles({ currentFileIds: fileIds });
        }
      }
    };

    initializeScene({ collabAPI, excalidrawAPI }).then(async (data) => {
      loadImages(data, /* isInitialLoad */ true);
      initialStatePromiseRef.current.promise.resolve(data.scene);
    });

    const onHashChange = async (event: HashChangeEvent) => {
      event.preventDefault();
      const libraryUrlTokens = parseLibraryTokensFromUrl();
      if (!libraryUrlTokens) {
        if (
          collabAPI.isCollaborating() &&
          !isCollaborationLink(window.location.href)
        ) {
          collabAPI.stopCollaboration(false);
        }
        excalidrawAPI.updateScene({ appState: { isLoading: true } });

        initializeScene({ collabAPI, excalidrawAPI }).then((data) => {
          loadImages(data);
          if (data.scene) {
            excalidrawAPI.updateScene({
              ...data.scene,
              ...restore(data.scene, null, null),
              commitToHistory: true,
            });
          }
        });
      }
    };

    const titleTimeout = setTimeout(
      () => (document.title = APP_NAME),
      TITLE_TIMEOUT,
    );

    const syncData = debounce(() => {
      if (isTestEnv()) {
        return;
      }
      if (!document.hidden && !collabAPI.isCollaborating()) {
        // don't sync if local state is newer or identical to browser state
        if (isBrowserStorageStateNewer(STORAGE_KEYS.VERSION_DATA_STATE)) {
          const localDataState = importFromLocalStorage();
          const username = importUsernameFromLocalStorage();
          let langCode = languageDetector.detect() || defaultLang.code;
          if (Array.isArray(langCode)) {
            langCode = langCode[0];
          }
          setLangCode(langCode);
          excalidrawAPI.updateScene({
            ...localDataState,
          });
          excalidrawAPI.updateLibrary({
            libraryItems: getLibraryItemsFromStorage(),
          });
          collabAPI.setUsername(username || "");
        }

        if (isBrowserStorageStateNewer(STORAGE_KEYS.VERSION_FILES)) {
          const elements = excalidrawAPI.getSceneElementsIncludingDeleted();
          const currFiles = excalidrawAPI.getFiles();
          const fileIds =
            elements?.reduce((acc, element) => {
              if (
                isInitializedImageElement(element) &&
                // only load and update images that aren't already loaded
                !currFiles[element.fileId]
              ) {
                return acc.concat(element.fileId);
              }
              return acc;
            }, [] as FileId[]) || [];
          if (fileIds.length) {
            LocalData.fileStorage
              .getFiles(fileIds)
              .then(({ loadedFiles, erroredFiles }) => {
                if (loadedFiles.length) {
                  excalidrawAPI.addFiles(loadedFiles);
                }
                updateStaleImageStatuses({
                  excalidrawAPI,
                  erroredFiles,
                  elements: excalidrawAPI.getSceneElementsIncludingDeleted(),
                });
              });
          }
        }
      }
    }, SYNC_BROWSER_TABS_TIMEOUT);

    const onUnload = () => {
      LocalData.flushSave();
    };

    const visibilityChange = (event: FocusEvent | Event) => {
      if (event.type === EVENT.BLUR || document.hidden) {
        LocalData.flushSave();
      }
      if (
        event.type === EVENT.VISIBILITY_CHANGE ||
        event.type === EVENT.FOCUS
      ) {
        syncData();
      }
    };

    window.addEventListener(EVENT.HASHCHANGE, onHashChange, false);
    window.addEventListener(EVENT.UNLOAD, onUnload, false);
    window.addEventListener(EVENT.BLUR, visibilityChange, false);
    document.addEventListener(EVENT.VISIBILITY_CHANGE, visibilityChange, false);
    window.addEventListener(EVENT.FOCUS, visibilityChange, false);
    return () => {
      window.removeEventListener(EVENT.HASHCHANGE, onHashChange, false);
      window.removeEventListener(EVENT.UNLOAD, onUnload, false);
      window.removeEventListener(EVENT.BLUR, visibilityChange, false);
      window.removeEventListener(EVENT.FOCUS, visibilityChange, false);
      document.removeEventListener(
        EVENT.VISIBILITY_CHANGE,
        visibilityChange,
        false,
      );
      clearTimeout(titleTimeout);
    };
  }, [collabAPI, excalidrawAPI, window.location.href]);

  useEffect(() => {
    const unloadHandler = (event: BeforeUnloadEvent) => {
      LocalData.flushSave();

      if (
        excalidrawAPI &&
        LocalData.fileStorage.shouldPreventUnload(
          excalidrawAPI.getSceneElements(),
        )
      ) {
        preventUnload(event);
      }
    };
    window.addEventListener(EVENT.BEFORE_UNLOAD, unloadHandler);
    return () => {
      window.removeEventListener(EVENT.BEFORE_UNLOAD, unloadHandler);
    };
  }, [excalidrawAPI]);

  useEffect(() => {
    languageDetector.cacheUserLanguage(langCode);
  }, [langCode]);

  const onChange = (
    elements: readonly ExcalidrawElement[],
    appState: AppState,
    files: BinaryFiles,
  ) => {
    if (collabAPI?.isCollaborating()) {
      collabAPI.syncElements(elements);
    }

    // this check is redundant, but since this is a hot path, it's best
    // not to evaludate the nested expression every time
    if (!LocalData.isSavePaused()) {
      LocalData.save(elements, appState, files, () => {
        if (excalidrawAPI) {
          let didChange = false;

          const elements = excalidrawAPI
            .getSceneElementsIncludingDeleted()
            .map((element) => {
              if (
                LocalData.fileStorage.shouldUpdateImageElementStatus(element)
              ) {
                const newElement = newElementWith(element, { status: "saved" });
                if (newElement !== element) {
                  didChange = true;
                }
                return newElement;
              }
              return element;
            });

          if (didChange) {
            excalidrawAPI.updateScene({
              elements,
            });
          }
        }
      });
    }
  };

  const onExportToBackend = async (
    exportedElements: readonly NonDeletedExcalidrawElement[],
    appState: AppState,
    files: BinaryFiles,
    canvas: HTMLCanvasElement | null,
  ) => {
    if (exportedElements.length === 0) {
      return window.alert(t("alerts.cannotExportEmptyCanvas"));
    }
    if (canvas) {
      try {
        await exportToBackend(
          exportedElements,
          {
            ...appState,
            viewBackgroundColor: appState.exportBackground
              ? appState.viewBackgroundColor
              : getDefaultAppState().viewBackgroundColor,
          },
          files,
        );
      } catch (error: any) {
        if (error.name !== "AbortError") {
          const { width, height } = canvas;
          console.error(error, { width, height });
          setErrorMessage(error.message);
        }
      }
    }
  };

  const renderTopRightUI = useCallback(
    (isMobile: boolean, appState: AppState) => {
      if (isMobile) {
        return null;
      }

      return (
        <NavigateAssignmentJSX
          hints={hints}
          onClickSubmit={onClickSubmit}
          onClickRaiseHand={onClickRaiseHand}
        />
      );
    },
    [hints],
  );

  const renderCustomStats = () => {
    return (
      <CustomStats
        setToast={(message) => excalidrawAPI!.setToast({ message })}
      />
    );
  };

  const onLibraryChange = async (items: LibraryItems) => {
    if (!items.length) {
      localStorage.removeItem(STORAGE_KEYS.LOCAL_STORAGE_LIBRARY);
      return;
    }
    const serializedItems = JSON.stringify(items);
    localStorage.setItem(STORAGE_KEYS.LOCAL_STORAGE_LIBRARY, serializedItems);
  };

  return (
    <>
      <div
        style={{ height: "100%" }}
        className={clsx("excalidraw-app", {
          "is-collaborating": isCollaborating,
        })}
      >
        <Excalidraw
          ref={excalidrawRefCallback}
          onChange={onChange}
          initialData={initialStatePromiseRef.current.promise}
          isCollaborating={isCollaborating}
          onPointerUpdate={collabAPI?.onPointerUpdate}
          UIOptions={{
            canvasActions: {
              export: {
                onExportToBackend,
                renderCustomUI: (elements, appState, files) => {
                  return (
                    <ExportToExcalidrawPlus
                      elements={elements}
                      appState={appState}
                      files={files}
                      onError={(error) => {
                        excalidrawAPI?.updateScene({
                          appState: {
                            errorMessage: error.message,
                          },
                        });
                      }}
                    />
                  );
                },
              },
            },
          }}
          renderTopRightUI={renderTopRightUI}
          // renderFooter={renderFooter}
          langCode={langCode}
          renderCustomStats={renderCustomStats}
          detectScroll={false}
          handleKeyboardGlobally={true}
          onLibraryChange={onLibraryChange}
          autoFocus={true}
        />
        {excalidrawAPI && <Collab excalidrawAPI={excalidrawAPI} />}
        {errorMessage && (
          <ErrorDialog
            message={errorMessage}
            onClose={() => setErrorMessage("")}
          />
        )}
      </div>
    </>
  );
};

const ExcalidrawApp = () => {
  return (
    <TopErrorBoundary>
      <Provider unstable_createStore={() => jotaiStore}>
        <ExcalidrawWrapper />
      </Provider>
    </TopErrorBoundary>
  );
};

export default ExcalidrawApp;
