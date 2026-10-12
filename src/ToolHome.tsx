import { useEffect, useState } from "react";
import { Info, ShieldCheck } from "lucide-react";
import type { DesktopAPI, PlatformScan } from "./shared/types";
import InstalledTools from "./InstalledTools";
import type { ToolInstall, ToolFeature } from "./shared/assistant";

export default function ToolHome({
  api,
  onError,
  onFiles,
  onToolDiagnosis,
  onProviders,
}: {
  api: DesktopAPI;
  onError: (text: string) => void;
  onFiles: () => void;
  onProviders: (tool?: ToolInstall) => void;
  onToolDiagnosis: (
    tool: ToolInstall,
    componentId: string,
    feature: ToolFeature,
  ) => void;
}) {
  const [scan, setScan] = useState<PlatformScan>();
  const [loadError, setLoadError] = useState("");
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true;
    setLoadError("");
    const unsubscribe = api.onPlatforms((value) => {
      if (active) setScan(value);
    });
    void api
      .platforms()
      .then((value) => {
        if (active) setScan(value);
      })
      .catch((e) => {
        if (active) setLoadError(e.message);
      });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [api, reload]);
  const action = async (id?: string) => {
    try {
      setScan(await api.scanPlatforms(id));
    } catch (e) {
      onError((e as Error).message);
    }
  };
  return (
    <div className="tool-home">
      <div className="page-heading">
        <div>
          <div className="eyebrow">LOCAL APPLICATIONS · INVENTORY</div>
          <h1>本机应用</h1>
          <p>查看工具与版本，选择应用检查相关模型服务或查看组件。</p>
        </div>
        <span className="badge green">
          <ShieldCheck size={14} />
          本地识别 · 不修改配置
        </span>
      </div>
      {loadError && (
        <div className="notice amber" role="alert">
          <Info size={16} />
          <div>
            网页入口参考信息加载失败：{loadError}。本机应用仍可使用。
            <button
              className="text-button"
              onClick={() => setReload((value) => value + 1)}
            >
              重试加载
            </button>
          </div>
        </div>
      )}
      <InstalledTools
        api={api}
        platformScan={scan}
        onCheckPlatform={(id) => void action(id)}
        onError={onError}
        onFiles={onFiles}
        onDiagnose={onToolDiagnosis}
        onProviders={onProviders}
      />
      <div className="tool-scope">
        <Info size={16} />
        <p>
          工具识别只读扫描本机应用与命令行路径；版本与更新信息不自动发送网络请求，
          除非你点击「检查更新」。
        </p>
      </div>
      <div className="tool-bottom">
        <div>
          <ShieldCheck size={17} />
          <span>检查只读进行，不会修改公司网络设置。</span>
        </div>
      </div>
    </div>
  );
}
