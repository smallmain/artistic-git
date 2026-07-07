use serde::{Deserialize, Serialize};
use specta::Type;

const PALETTE: [&str; 12] = [
    "#2563eb", "#16a34a", "#dc2626", "#9333ea", "#ea580c", "#0891b2", "#4f46e5", "#65a30d",
    "#be123c", "#0d9488", "#7c3aed", "#ca8a04",
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HistoryGraphCommit {
    pub id: String,
    pub parents: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HistoryGraphPageInput {
    pub commits: Vec<HistoryGraphCommit>,
    pub open_lanes: HistoryGraphState,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HistoryGraphState {
    pub lanes: Vec<HistoryGraphLane>,
    pub next_color_index: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HistoryGraphLane {
    pub target: String,
    pub color: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HistoryGraphPage {
    pub rows: Vec<HistoryGraphRow>,
    pub next_open_lanes: HistoryGraphState,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HistoryGraphRow {
    pub commit_id: String,
    pub node: HistoryGraphNode,
    pub lane_count: usize,
    pub lanes_before: Vec<HistoryGraphLane>,
    pub lanes_after: Vec<HistoryGraphLane>,
    pub segments: Vec<HistoryGraphSegment>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HistoryGraphNode {
    pub lane: usize,
    pub color: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HistoryGraphSegment {
    pub from_lane: usize,
    pub to_lane: usize,
    pub from_y: GraphAnchor,
    pub to_y: GraphAnchor,
    pub color: String,
    pub kind: HistoryGraphSegmentKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum GraphAnchor {
    Top,
    Middle,
    Bottom,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum HistoryGraphSegmentKind {
    Vertical,
    Parent,
    Merge,
}

pub fn layout_history_graph_page(input: HistoryGraphPageInput) -> HistoryGraphPage {
    let mut state = input.open_lanes;
    let mut rows = Vec::with_capacity(input.commits.len());

    for commit in input.commits {
        let (node_lane, duplicate_lanes) = ensure_node_lane(&mut state, &commit.id);
        let lanes_before = state.lanes.clone();
        let node_color = lanes_before[node_lane].color.clone();
        let mut segments = vertical_segments(&lanes_before);

        for duplicate_lane in &duplicate_lanes {
            segments.push(HistoryGraphSegment {
                from_lane: *duplicate_lane,
                to_lane: node_lane,
                from_y: GraphAnchor::Top,
                to_y: GraphAnchor::Middle,
                color: lanes_before[*duplicate_lane].color.clone(),
                kind: HistoryGraphSegmentKind::Merge,
            });
        }

        remove_lanes(&mut state.lanes, &duplicate_lanes);
        let node_lane = state
            .lanes
            .iter()
            .position(|lane| lane.target == commit.id)
            .expect("node lane remains after duplicate lane removal");

        update_parents(&mut state, node_lane, &commit.parents, &mut segments);
        let lanes_after = state.lanes.clone();
        let lane_count = lanes_before.len().max(lanes_after.len()).max(node_lane + 1);

        rows.push(HistoryGraphRow {
            commit_id: commit.id,
            node: HistoryGraphNode {
                lane: node_lane,
                color: node_color,
            },
            lane_count,
            lanes_before,
            lanes_after,
            segments,
        });
    }

    HistoryGraphPage {
        rows,
        next_open_lanes: state,
    }
}

fn ensure_node_lane(state: &mut HistoryGraphState, commit_id: &str) -> (usize, Vec<usize>) {
    let mut matches = state
        .lanes
        .iter()
        .enumerate()
        .filter_map(|(index, lane)| (lane.target == commit_id).then_some(index));

    if let Some(first) = matches.next() {
        return (first, matches.collect());
    }

    let color = next_color(&mut state.next_color_index);
    state.lanes.push(HistoryGraphLane {
        target: commit_id.to_owned(),
        color,
    });
    (state.lanes.len() - 1, Vec::new())
}

fn vertical_segments(lanes: &[HistoryGraphLane]) -> Vec<HistoryGraphSegment> {
    lanes
        .iter()
        .enumerate()
        .map(|(lane_index, lane)| HistoryGraphSegment {
            from_lane: lane_index,
            to_lane: lane_index,
            from_y: GraphAnchor::Top,
            to_y: GraphAnchor::Bottom,
            color: lane.color.clone(),
            kind: HistoryGraphSegmentKind::Vertical,
        })
        .collect()
}

fn update_parents(
    state: &mut HistoryGraphState,
    node_lane: usize,
    parents: &[String],
    segments: &mut Vec<HistoryGraphSegment>,
) {
    match parents {
        [] => {
            state.lanes.remove(node_lane);
        }
        [first_parent] => {
            state.lanes[node_lane].target = first_parent.clone();
        }
        [first_parent, extra_parents @ ..] => {
            state.lanes[node_lane].target = first_parent.clone();
            let node_color = state.lanes[node_lane].color.clone();
            segments.push(HistoryGraphSegment {
                from_lane: node_lane,
                to_lane: node_lane,
                from_y: GraphAnchor::Middle,
                to_y: GraphAnchor::Bottom,
                color: node_color,
                kind: HistoryGraphSegmentKind::Parent,
            });

            for (offset, parent) in extra_parents.iter().enumerate() {
                let lane = node_lane + offset + 1;
                let color = next_color(&mut state.next_color_index);
                state.lanes.insert(
                    lane,
                    HistoryGraphLane {
                        target: parent.clone(),
                        color: color.clone(),
                    },
                );
                segments.push(HistoryGraphSegment {
                    from_lane: node_lane,
                    to_lane: lane,
                    from_y: GraphAnchor::Middle,
                    to_y: GraphAnchor::Bottom,
                    color,
                    kind: HistoryGraphSegmentKind::Parent,
                });
            }
        }
    }
}

fn remove_lanes(lanes: &mut Vec<HistoryGraphLane>, indexes: &[usize]) {
    for index in indexes.iter().rev() {
        lanes.remove(*index);
    }
}

fn next_color(next_color_index: &mut usize) -> String {
    let color = PALETTE[*next_color_index % PALETTE.len()].to_owned();
    *next_color_index += 1;
    color
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn carries_open_merge_lane_across_pages() {
        let page_one = layout_history_graph_page(HistoryGraphPageInput {
            commits: vec![commit("m", &["a", "b"]), commit("a", &["root"])],
            open_lanes: HistoryGraphState::default(),
        });

        assert_eq!(page_one.rows[0].node.lane, 0);
        assert_eq!(
            page_one
                .rows
                .first()
                .unwrap()
                .segments
                .iter()
                .filter(|segment| segment.kind == HistoryGraphSegmentKind::Parent)
                .count(),
            2,
        );
        assert_eq!(
            page_one.next_open_lanes.lanes,
            vec![
                HistoryGraphLane {
                    target: "root".to_owned(),
                    color: "#2563eb".to_owned(),
                },
                HistoryGraphLane {
                    target: "b".to_owned(),
                    color: "#16a34a".to_owned(),
                },
            ],
        );

        let page_two = layout_history_graph_page(HistoryGraphPageInput {
            commits: vec![commit("b", &["root"]), commit("root", &[])],
            open_lanes: page_one.next_open_lanes,
        });

        assert_eq!(page_two.rows[0].node.lane, 1);
        assert_eq!(page_two.rows[0].node.color, "#16a34a");
        assert_eq!(page_two.rows[1].node.lane, 0);
        assert!(page_two.next_open_lanes.lanes.is_empty());
    }

    #[test]
    fn compacts_duplicate_open_lanes_when_branches_share_parent() {
        let page = layout_history_graph_page(HistoryGraphPageInput {
            commits: vec![
                commit("left", &["base"]),
                commit("right", &["base"]),
                commit("base", &[]),
            ],
            open_lanes: HistoryGraphState::default(),
        });

        assert_eq!(page.rows[2].node.lane, 0);
        assert!(page.rows[2]
            .segments
            .iter()
            .any(|segment| segment.kind == HistoryGraphSegmentKind::Merge));
        assert!(page.next_open_lanes.lanes.is_empty());
    }

    #[test]
    fn preserves_unrelated_open_lanes_while_root_finishes() {
        let page = layout_history_graph_page(HistoryGraphPageInput {
            commits: vec![commit("done", &[])],
            open_lanes: HistoryGraphState {
                lanes: vec![
                    HistoryGraphLane {
                        target: "done".to_owned(),
                        color: "#2563eb".to_owned(),
                    },
                    HistoryGraphLane {
                        target: "later".to_owned(),
                        color: "#16a34a".to_owned(),
                    },
                ],
                next_color_index: 2,
            },
        });

        assert_eq!(
            page.next_open_lanes.lanes,
            vec![HistoryGraphLane {
                target: "later".to_owned(),
                color: "#16a34a".to_owned(),
            }]
        );
    }

    fn commit(id: &str, parents: &[&str]) -> HistoryGraphCommit {
        HistoryGraphCommit {
            id: id.to_owned(),
            parents: parents.iter().map(|parent| (*parent).to_owned()).collect(),
        }
    }
}
