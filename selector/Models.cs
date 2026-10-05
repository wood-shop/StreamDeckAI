using System.Text.Json.Serialization;

namespace StreamDeckAI.Selector;

public sealed class AppsFile
{
    [JsonPropertyName("schema")] public int Schema { get; set; } = 1;
    [JsonPropertyName("updatedAt")] public string? UpdatedAt { get; set; }
    [JsonPropertyName("source")] public string? Source { get; set; }
    /// <summary>
    /// When true (default), list apps with status developing alongside released.
    /// Null/missing in JSON means ON so legacy apps.json keeps showing Defaults agents.
    /// </summary>
    [JsonPropertyName("showDeveloping")] public bool? ShowDeveloping { get; set; } = true;

    [JsonIgnore] public bool ShowDevelopingOrDefault => ShowDeveloping != false;

    [JsonPropertyName("apps")] public List<CatalogApp> Apps { get; set; } = new();
}

public sealed class CatalogApp
{
    [JsonPropertyName("id")] public string Id { get; set; } = "";
    [JsonPropertyName("name")] public string Name { get; set; } = "";
    [JsonPropertyName("category")] public string? Category { get; set; }
    [JsonPropertyName("status")] public string? Status { get; set; }
    [JsonPropertyName("enabled")] public bool Enabled { get; set; }
    [JsonPropertyName("streamdeck")] public StreamDeckMeta? Streamdeck { get; set; }
}

public sealed class StreamDeckMeta
{
    [JsonPropertyName("agent")] public string Agent { get; set; } = "";
    [JsonPropertyName("enabledDefault")] public bool? EnabledDefault { get; set; }
}
